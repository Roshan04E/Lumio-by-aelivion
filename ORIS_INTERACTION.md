# ORIS Interaction Architecture — Research Investigation

> **What this file is:** the research phase that precedes writing an ADR on how a human
> interacts with ORIS. It surveys the space, analyses why the current surfaces fail, extracts
> principles from human collaboration and from creative tooling, enumerates and evaluates
> candidate interaction architectures, and states falsifiable hypotheses.
>
> **What this file is not:** a UI design, a mockup, a feature list, or a plan to improve the
> chat panel. It contains no screens and proposes no widgets. Where the argument reaches the
> point at which the next question is visual, it stops and says so.
>
> **Scope boundary, stated once.** Per the brief, ORIS's *intelligence* is assumed: memory,
> replay, evidence, world model, planning, long-term learning all exist and work. Every
> failure analysed here is therefore an **interaction** failure. This is a deliberate and
> unusual framing, and it turns out to be the productive one — §2.5 argues that the majority
> of what makes today's AI surfaces feel wrong survives untouched by a perfect model.
>
> **Relationship to the ORIS doc set (don't duplicate):**
> - [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) — the organism. Treated as fixed.
> - [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) — state, 8 phases, 13 operators, laws. Fixed.
> - [`ORIS_TIME.md`](ORIS_TIME.md) — two clocks, seven bands. **Load-bearing here** (§7.1).
> - [`ORIS_VALUES.md`](ORIS_VALUES.md) — the error taxonomy and tiers. Load-bearing (§7.4).
> - [`ORRERIS_OS.md`](ORRERIS_OS.md) — the habitat. Never contradicted.
> - [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) — today's shipping tiered brain and surfaces.
>
> **Status:** v0, 2026-08-03. Research document. **Nothing here is shipped or decided.**
> Tags as in the sibling docs: **[PRIOR ART]** rests on established results, **[NOVEL]** is a
> claim we believe is unsolved elsewhere and therefore carries research risk, **[HYPOTHESIS]**
> is unvalidated and appears in Part 8 with a metric.

---

## Part 0 — The thesis, stated up front so the rest can be checked against it

Three claims. Everything below is an argument for one of them.

> **1. "Chat" is a transport that has been mistaken for an interaction model.** Text-in /
> text-out is a perfectly good *channel*. It became the interaction architecture of the entire
> field by accident of what was easy to ship in 2022, and the field has been retrofitting
> collaboration onto a message queue ever since.
>
> **2. The dominant failure is not fluency but *grounding*.** Current surfaces force the human
> to linguistically reconstruct, every turn, a situation the software already knows — which
> object, which moment, which intent, which history. Human collaborators do not do this,
> because they share a workspace and a referent. This is the single largest recoverable cost,
> and it is an architecture problem, not a model problem.
>
> **3. The ORIS band ladder already predicts the interaction architecture.** [NOVEL] Seven
> timescales exist in the cognitive design, each with its own period and reach. Chat collapses
> all seven into one — the turn — and that collapse *is* most of what feels wrong. An
> interaction architecture with one surface per band, at that band's natural cadence, falls out
> of an architecture that is already committed to. §7.1 is the load-bearing section of this
> document.

If those three survive the rest of the investigation, the recommendation in Part 10 follows
almost mechanically. They are stated here so that a reader who disagrees knows exactly where
to attack.

---

# PART 1 — Current AI interaction taxonomy

## 1.1 The wrong way to taxonomise, and why

The usual axis is **modality** — text, voice, image, multimodal. It is nearly useless. It
predicts none of the behavioural differences that matter: ChatGPT voice mode and ChatGPT text
mode are the *same* interaction architecture with a codec swapped, and they fail in the same
ways for the same reasons (§2.6). Meanwhile GitHub Copilot's ghost text and Cursor's chat are
both "text" and are architecturally unrelated.

The axes that actually separate systems:

| Axis | Question it answers | Values |
|---|---|---|
| **Initiative** | Who may start a contribution? | user-only · system-only · negotiated · continuous |
| **Referent** | What is the interaction *about*, structurally? | a transcript · the artifact · a selection · the whole workspace |
| **Situatedness** | Does the system know where the user is without being told? | none · session-scoped · workspace-scoped · continuous |
| **Persistence** | What survives the session? | nothing · a transcript · a summary · a model |
| **Turn structure** | How is the floor allocated? | strict alternation · half-duplex VAD · full-duplex · no turns |
| **Commitment** | When does a contribution become consequential? | on utterance · on accept · on merge · never (advisory) |
| **Cost of ignoring** | What does the user pay to disregard a contribution? | zero · a glance · a dismissal · a reply |
| **Evidence yield** | Does the exchange produce a scoreable outcome? | none · implicit · explicit · labelled pair |

The last axis is not in the HCI literature and is added here because ORIS needs it. A
cognitive architecture built on a Prediction Ledger (`ORIS_ARCHITECTURE.md` §7, ORIS-4)
**cannot develop through an interaction surface that produces no scoreable outcomes.** It is
argued in §5 that this axis alone eliminates several otherwise attractive candidates, and it
is the one criterion here that is specific to this project rather than general.

## 1.2 The families

Six recurring architectures, and a seventh that is mostly aspiration.

**F1 · Conversational assistant.** ChatGPT, Claude, Gemini, Copilot Chat. Strict alternation;
referent is the transcript; situatedness none-to-session; commitment on utterance; ignoring
costs a reply. The interaction philosophy is *the oracle*: a knowledgeable stranger reachable
by letter, who knows nothing until told.

**F2 · Realtime voice agent.** OpenAI Voice Mode, Gemini Live, realtime API agents. F1 with a
speech codec and VAD-based floor allocation. Philosophy: *the phone call*. Adds prosody and
removes the transcript's greatest strength (scannability, persistence, editability) — an
unusually clean case of a modality change that is architecturally a regression (§2.6).

**F3 · Inline continuation.** GitHub Copilot ghost text, Gmail Smart Compose, Notion AI inline.
No turns at all; referent is the artifact at the cursor; system-initiated continuously;
commitment on accept (Tab); **ignoring costs zero** — the single most important property in the
whole taxonomy. Philosophy: *the completion*, not the conversation.

**F4 · Diff-mediated agent.** Cursor Composer, Claude Code, Windsurf Cascade, Replit Agent,
Lovable. The system acts on the artifact and returns a **reviewable proposal**. Referent is the
artifact; commitment on merge; ignoring costs a rejection; evidence yield is high and *labelled*
(accept / reject / edit-then-accept is a supervised signal). Philosophy: *the pull request*.

**F5 · Palette / intent line.** Raycast AI, Cmd-K everywhere, Spotlight-class launchers. Language
used as a **command channel** rather than a conversation: one shot, no history, no persona,
dismissed on completion. Philosophy: *the imperative*. Chronically underrated; it is what most
"chat" traffic actually is (§2.2).

**F6 · Generative surface.** Photoshop Generative Fill, Firefly, Figma AI, DAW stem-splitters.
The interaction is a *selection plus a parameter*, with language as one parameter among several.
Referent is a region of the artifact. Philosophy: *the tool*, not the agent. Notably, these are
the AI surfaces professionals adopt fastest, which is evidence about something (§4.3).

**F7 · Ambient / situated assistant.** Apple Intelligence's stated ambition, Microsoft Recall,
agent-OS demos, most HCI research prototypes since Ubicomp. Continuous observation, occasional
proactive contribution. Philosophy: *the resident*. Almost nothing ships here, and the reasons
are instructive rather than incidental: it is the family that most needs persistent memory,
calibrated confidence, and an interruption policy — i.e. exactly the things ORIS is building
and everyone else has to fake.

## 1.3 Classification of the named systems

Interaction philosophy in one line each; capability is deliberately not assessed.

| System | Family | Interaction philosophy | The one thing it gets right | The one thing it gets wrong |
|---|---|---|---|---|
| ChatGPT | F1 (+F2) | The oracle you write to | Made "just say what you want" universal | Every turn re-establishes a world it could have observed |
| Claude (chat) | F1 | The considered correspondent | Turn quality; long-context reference | Same as above; the artifact is pasted, not shared |
| Gemini (in-app) | F1+F6 | The assistant beside the document | Genuine app context in places | Context is *retrieved*, not *shared* — it reads your doc, it isn't in it with you |
| Microsoft Copilot | F1+F6 | The org-wide answer layer | Retrieval over real work artifacts | Chat bolted to every app uniformly; no per-app interaction grammar |
| Cursor | F4+F3 | The pair programmer with commit rights | Diff-as-proposal; referent is the code | Two disjoint surfaces (tab vs chat) with no shared attention model |
| Windsurf | F4 | The autonomous flow | Long-horizon action with checkpoints | Initiative is a mode you pick, not a negotiated variable |
| GitHub Copilot | F3 | The completion | **Zero cost to ignore** — the best-solved problem in the field | Cannot be addressed, questioned, or corrected; no memory of being wrong |
| Apple Intelligence | F7 (claimed) | The ambient system layer | Correct instinct: no chat box for most tasks | Little persistence; the "resident" is re-instantiated per invocation |
| Raycast AI | F5 | The imperative line | Ephemerality as a feature; no persona tax | Deliberately stateless — no relationship is possible, by design |
| Notion AI | F3+F6 | Writing tool with generative verbs | Verbs attached to selections | Two grammars (inline vs chat) that don't share a referent |
| Adobe Firefly | F6 | The generator | Parameters, not prose, where parameters are better | Standalone surface; not situated in the work |
| Photoshop Generative Fill | F6 | Selection + intent + layer | **Result lands as an editable layer** — non-destructive by construction | No memory of your last 200 fills; every fill is the first one |
| Figma AI | F6 (+F1) | Generative verbs in a multiplayer canvas | Lives inside the best presence model shipping (§4.4) | Does not participate in that presence model — the AI has no cursor |
| Replit Agent | F4 | The contractor | Long autonomous runs with visible artifacts | Progress narration substitutes for shared attention |
| Lovable | F4 | Describe-and-receive | Extremely low floor for non-experts | Prose is the only channel; the artifact can't be pointed at |
| Manus | F4+F7 | The delegated worker | Explicit task decomposition surfaced as state | Delegation is all-or-nothing; no mid-task co-presence |
| OpenAI Voice Mode | F2 | The phone call | Prosody, barge-in, low latency within the turn | VAD floor allocation; the transcript is gone (§2.6) |
| Realtime agents (general) | F2 | Full-duplex speech | Duplex audio is genuinely solved | Duplex *audio* is not duplex *conversation* (§3.2) |
| HCI research prototypes | F7 | Situated, mixed-initiative | Decades of correct principles (§3, §5) | Almost never deployed long enough for the relationship to exist |

## 1.4 The pattern in the table

Read the "gets wrong" column vertically. Almost every entry is one of four things:

1. **The referent is prose when it could be the artifact.** (F1, F2, and the chat halves of
   the hybrids.)
2. **Situatedness is retrieved rather than shared.** The system fetches context per invocation
   instead of continuously inhabiting it. This is the difference between a colleague who reads
   your file when asked and one who was in the room while you made it.
3. **Initiative is a mode, not a variable.** Systems offer "ask" or "agent," and the user
   becomes the router — deciding, before each request, how much autonomy to grant. Humans never
   ask a collaborator to pre-declare their autonomy level.
4. **The relationship has no substrate.** Nothing accumulates. The 200th interaction costs what
   the 1st did, and the system cannot be *known* by the user or vice versa.

ORIS is, by construction, the first of these systems for which (2) and (4) are already solved
architecturally. That is precisely why continuing to use a surface designed around their
absence would be the expensive mistake.

---

# PART 2 — Failure analysis of chat-first systems

## 2.1 The framing: what a chat interface actually is

A chat interface is a **serialised, append-only, symmetric-latency, single-channel, committed-
utterance, transcript-referent message queue between two parties who share no workspace.**

Every clause is a design decision, and every one of them is wrong for a professional creative
tool:

| Property | What it buys | What it costs here |
|---|---|---|
| Serialised | Simple state; no concurrency | Forbids parallel work — the normal case for a collaborator |
| Append-only | Auditability | No revision, no repair, no retraction of an in-flight contribution |
| Symmetric latency | Uniform implementation | Trivial and profound asks look identical and feel identical (§2.4) |
| Single-channel | One place to look | Seven timescales collapse into one (§7.1) |
| Committed utterance | Clean protocol | No incremental production, therefore no repair (§3.3) |
| Transcript referent | Portable, model-friendly | The workspace is invisible; everything must be re-described (§2.2) |
| No shared workspace | Works for any backend | Discards the single largest source of free grounding |

None of these are LLM properties. All of them are properties of a message queue.

## 2.2 Failure 1 — The grounding tax **[the largest single cost]**

In human collaboration, the overwhelming majority of reference is **deictic**: *this, that, here,
now, again, like before, the one you did yesterday.* Clark & Brennan's grounding theory
[PRIOR ART] shows collaborators minimise **collaborative effort**, not individual effort, and that
a shared workspace collapses the cost of establishing reference to near zero — you point.

Chat has no pointing. Every referent must be *described*, and description is:

- **expensive** — the user composes a noun phrase for something already selected on screen;
- **ambiguous** — natural language under-determines which of four similar clips is meant;
- **lossy** — "the warm bit near the end" discards the frame-exact information the app has;
- **repeated** — the same referent is reconstructed next turn, and the turn after.

The repo's own evidence corroborates this at the cost layer rather than the interaction layer.
`AI_ARCHITECTURE.md` documents *"change text color of clip 3 to white"* costing 3–6 s of LLM
reasoning plus a closing call, and *"keyframe the blur amount"* burning thousands of reasoning
tokens re-deriving an answer the registries already contain. The brain redesign correctly
diagnosed that as a **routing** failure and fixed it with a tier cascade. But there is a second,
untouched diagnosis of the same transcript: **the phrase "clip 3" exists only because the
interface gave the user no way to point at the clip they had already selected.** The tier
cascade made the wrong abstraction cheap. It did not remove the abstraction.

> **[HYPOTHESIS IH-1]** A large fraction of tokens and of user composition time in the existing
> corpus is spent re-establishing reference that the focus state already holds. Measurable
> today against `AI_REFINEMENT.md` and the 50-prompt ledger. Stated with a metric in Part 8.

This is the clearest instance of the general shape: **an interaction architecture that discards
information the system already has, and then pays a model to reconstruct it.**

## 2.3 Failure 2 — The turn is the wrong quantum

Conversation Analysis [PRIOR ART: Sacks, Schegloff & Jefferson 1974] establishes that human
turn-taking is not alternation over a shared channel. It is **continuous mutual monitoring**
in which:

- utterances are built from **turn-constructional units** whose completion is *projectable*
  before it happens;
- the floor changes at **transition-relevance places** predicted in advance, not detected after;
- median inter-speaker gap is ~200 ms — *shorter than the time to plan an utterance* — which
  proves listeners begin producing before the speaker finishes;
- overlap is frequent, structured, and not an error.

A turn-based message queue cannot express any of this. What we call a "turn" in chat is a
**commitment boundary**, not a conversational turn: once sent, it cannot be revised, hedged,
narrowed as it lands, or abandoned mid-course when the recipient's face changes. Humans do all
four constantly.

The consequence is that chat forces **full specification up front**. The user must anticipate
everything the system will need, because there is no cheap mid-course correction. That is why
prompt engineering exists as a discipline: it is the user compensating, in advance, for an
interaction architecture that has no repair channel.

## 2.4 Failure 3 — Symmetric latency and the missing effort signal

Human collaborators **grade their effort visibly**. A quick answer arrives quickly; a hard one
is preceded by *"hm, give me a second"*, a pause, a change of posture. This is not politeness —
it is information. It tells the asker how expensive the ask was, which recalibrates the next
ask, which is a feedback loop that makes long collaborations efficient.

Chat flattens this. A trivial question and a profound one both produce: an indeterminate wait,
then a wall of text. There is no cost signal, therefore no calibration, therefore users develop
superstitions about what is expensive ("I should be polite / I should be terse / I should give
examples") in place of a model.

ORIS is unusual in that it *has the true signal already* — the tier cascade knows whether a
request resolved at tier 0 or escalated to tier 4, and interoception (`ORIS_ARCHITECTURE.md` §3.2)
knows the body cost. `AI_ARCHITECTURE.md`'s honest-labels rule already surfaces the route. The
architectural observation is that **route and body state are effort signals, and effort signals
are social signals**; today they are rendered as a provenance label rather than used as
interaction structure.

## 2.5 Failure 4 — Attributing the failures correctly

The central diagnostic question in the brief. The answer matters because it determines whether
this investigation is worth doing at all: if the failures are model-caused, the correct action
is to wait for better models.

| Failure | LLM-caused | Interaction-design-caused | Architecture-caused | Verdict |
|---|---|---|---|---|
| Must re-describe on-screen objects | ✗ | ✗ | **✓** | No shared referent exists to point at |
| No memory of last week | ✗ | ✗ | **✓** | No persistence substrate (solved in ORIS) |
| Cannot start a contribution unprompted | ✗ | **✓** | ✓ | Request/response transport + no interruption policy |
| Answers are too long / hedged | **✓** | ✓ | ✗ | Training objective, plus no recipient model |
| Sycophancy | **✓** | ✗ | ✓ | RLHF objective; ORIS-3 is the architectural counter |
| No mid-utterance repair | ✗ | **✓** | ✓ | Committed-utterance protocol |
| Can't tell when to stay quiet | ✗ | ✓ | **✓** | Requires an expectation-gap model — architecture |
| Voice feels like walkie-talkie | ✗ | **✓** | ✓ | VAD floor allocation, not model quality (§2.6) |
| Confidence is uncalibrated | **✓** | ✗ | ✓ | Models are miscalibrated; ledgers fix it externally |
| Effort/cost invisible | ✗ | **✓** | ✗ | Pure surface decision |
| Every session starts cold | ✗ | ✗ | **✓** | Persistence (solved in ORIS) |
| The user must route (ask vs agent) | ✗ | **✓** | ✓ | Initiative modelled as a mode, not a variable |
| Hallucination about project state | ✓ | ✗ | **✓** | Grounding in a world model, not a better model |

**Count: three failures are primarily LLM-caused; ten are not.** Two of the three (sycophancy,
calibration) already have architectural counters in the ORIS design. This is the empirical
basis for the brief's own framing, and it justifies treating interaction as the live problem.

> **The honest inverse.** Better models *do* fix some of this, and pretending otherwise would
> be motivated reasoning. Longer context reduces the persistence gap; better instruction
> following reduces verbosity; tool use reduces state hallucination. The claim is not that
> models don't matter — it is that the **residual after perfect models is large, structural, and
> exactly the part this document is about.** A perfect model in a chat box still cannot point,
> still cannot stay quiet for the right reason, and still cannot know you paused.

## 2.6 Failure 5 — Why voice mode is still voice *chat*

Voice mode is the cleanest natural experiment available, because it changes modality while
holding architecture constant. The result: it feels different and fails identically. Reasons,
in order of severity:

**(a) The floor is allocated by silence detection, not by projection.** VAD waits for ~500–1000 ms
of silence to decide you are done. Human turn transition is *predictive* — listeners project the
completion point and begin at ~200 ms, often overlapping. A silence-detecting system is
**structurally incapable** of human-like turn transition, no matter how fast the model is: it
must wait longer than a human would, and it must interpret thinking-pauses as turn-ends. This is
an algorithmic-class limitation, not a latency budget. [PRIOR ART: the incremental-dialogue
literature — Schlangen & Skantze's IU model — has argued this for fifteen years and is largely
unimplemented in shipping products.]

**(b) There is no shared referent, and speech makes it worse.** Text at least lets you paste.
Voice removes even that, so the grounding tax (§2.2) rises. Voice is the *worst* modality for
reference and the *best* for negotiation and nuance — which is an argument for making modality a
property of the message, not of the session (Principle IX-13).

**(c) Backchannels are absent or fake.** Human listeners produce *mm-hm*, *right*, *wait* —
continuous evidence of uptake at Clark's understanding level. A system that generates these
without them meaning anything is producing theater, which for ORIS is not merely tacky but
prohibited (ORIS-2). So ORIS **may not** solve voice presence the way the field is currently
solving it. That is a real constraint and it is discussed in §7.5.

**(d) It is half-duplex where work is full-duplex.** Speaking to a voice agent while scrubbing a
timeline means the two channels are unrelated: the agent hears words and sees nothing. A human
in the room sees the scrub, and the scrub *is* half the utterance.

**(e) Transcript loss.** Text's most underrated property is that it persists, is scannable, and
can be edited and re-sent. Voice discards all three and returns nothing structural in exchange.

> **Conclusion for the ORIS voice surface:** the deficiency is not that voice is bad but that
> **voice-as-a-session** is bad. Voice as a *channel for particular message types* — hands
> occupied, eyes on the picture, negotiating taste — is defensible and possibly excellent. Voice
> as the interaction architecture is F1 with worse grounding.

## 2.7 Failure 6 — The initiative dichotomy, and why users become routers

Every shipping system offers essentially two settings: *it does nothing until asked*, or *it goes
off and does a lot*. The user chooses per-request. This is a design failure with a specific
signature: **the human is doing the system's arbitration.**

Horvitz's mixed-initiative principles [PRIOR ART: 1999] specified the alternative in detail —
compute the expected utility of acting versus asking versus waiting, weigh the cost of poorly
timed interruption, and let uncertainty about intent govern the choice. Twenty-seven years later,
essentially nothing ships this, for a knowable reason: **it requires calibrated confidence, a
model of the user's current attentional cost, and a memory of past interruption outcomes.** Those
are exactly the three things a stateless chat product cannot have — and exactly three things ORIS
is already building (ledger, interoception + focus state, experience stream).

This is the strongest single argument that ORIS should not inherit the industry's interaction
architecture: **the industry's architecture is shaped by the absence of the things ORIS has.**

## 2.8 Failure 7 — Zero evidence yield

A chat exchange ends and the system learns almost nothing verifiable. Did the user accept?
Unknown — they said "thanks" and did something else. Did the suggestion work? Unknown. Was the
confidence justified? Unrecorded.

Compare F3/F4: a ghost-text completion produces **accepted / rejected / accepted-then-edited**,
which is a labelled training pair with a timestamp. A diff produces the same, plus the exact
delta between what was proposed and what was kept — which is a *gradient*, not a scalar.

For a system whose entire development mechanism is `expect → act → compare → attribute → adapt`
(`ORIS_CALCULUS.md` §2), an interaction surface that does not emit scoreable outcomes is not
merely suboptimal — **it starves the organism.** Invariant ORIS-4 says every consequential act
carries a prior claim; a surface that never resolves the claim makes the invariant unenforceable.

> **[NOVEL] Evidence yield is an interaction-design criterion, not just a learning concern.**
> We are not aware of it being used to select between interaction architectures anywhere. For
> ORIS it may be the *decisive* criterion (§5.4).

## 2.9 Failure 8 — The persona tax

Chat imposes a social frame. Once there is a message box with a name above it, the user is in a
conversation with a *someone*, which triggers politeness, reluctance to correct, reluctance to
abandon mid-task, and interpretation of terseness as mood. Professionals working at speed do not
want a relationship with their inspector panel.

This interacts directly with ORIS-2 (no theater) and ORIS-3 (anti-sycophancy). The persona frame
*invites* both failures: it makes performed warmth feel natural and disagreement feel rude. An
interaction architecture that reduces the persona surface makes the invariants easier to hold —
which is an unusual case of interaction design doing safety work.

## 2.10 Summary of Part 2

Eight failures. **One and a half are the model's.** The rest are consequences of a transport
that was never designed for collaboration, and the deepest of them — grounding, initiative,
evidence yield — get *worse* as the model gets better, because a more capable partner trapped in
a request/response queue wastes more.

---

# PART 3 — Human collaboration principles

The question is not "how do humans converse" but **which properties of human collaboration are
mechanisms that transfer, and which are artifacts of having bodies.** The literature is
unusually good here and unusually ignored by product work.

## 3.1 Grounding — the core mechanism [PRIOR ART: Clark & Brennan 1991; Clark 1996]

Communication is a **joint action** in which participants accumulate **common ground** and
establish mutual belief that each contribution has been understood — to a *grounding criterion*
sufficient for current purposes, not perfectly.

Two results transfer directly:

**The action ladder.** Every contribution succeeds or fails at four levels, and failure at a
lower level makes higher levels moot:

```
4  UPTAKE          the addressee takes up the proposed joint project     ← "yes, do that"
3  UNDERSTANDING   the addressee understands what was meant              ← the hard one
2  IDENTIFICATION  the addressee identifies the signal                   ← heard the words
1  ATTENTION       the addressee is attending                            ← is looking
```

Chat provides *no evidence at levels 1–3*. It jumps from "message delivered" to "reply." Humans
supply continuous level-1/2/3 evidence — gaze, backchannels, the hand hovering over the right
object. **Ambient evidence of attention and understanding, without a turn, is the thing chat
most conspicuously lacks**, and it is a much more precise statement of the "presence" intuition
in the brief than "it should feel alive."

**Least collaborative effort.** Participants minimise *joint* effort. This is the formal reason a
shared workspace beats description: pointing costs the pointer ~0 and the recipient ~0, whereas
describing costs the describer a lot and the recipient disambiguation work.

**Referential pacts** [Brennan & Clark 1996]: partners converge on stable names for things
("the b-roll block") and *keep them*, per-partner. This is a long-lived interaction structure
that requires memory of the partner — impossible for stateless systems, natural for ORIS.

## 3.2 Turn-taking and the floor [PRIOR ART: Sacks/Schegloff/Jefferson 1974; Levinson 2016]

Covered in §2.3; the transferable mechanisms:

- **Projection, not detection.** Turn ends are predicted from syntax, prosody, and action
  completion. Transferable in software wherever the *action* is observable: a user who has just
  set an out-point and released the mouse has completed a unit, and that is projectable without
  parsing a word.
- **Silence is typed.** A 0.7 s gap before an answer is heard as trouble; a gap after a proposal
  is heard as disagreement. Silence carries meaning by its *position*, not its duration.
- **Overlap is legitimate.** Full-duplex is normal; the goal is not to avoid collision but to
  have repair for it.
- **Preference organisation.** Agreement is fast and unmarked; disagreement is delayed, hedged,
  and accounted for. A system that disagrees *instantly and flatly* reads as hostile even when
  correct — a real design constraint on an anti-sycophancy system (ORIS-3), and an interaction
  problem, not a values problem.

## 3.3 Repair — the most under-implemented mechanism [PRIOR ART: Schegloff et al. 1977]

Human conversation is saturated with repair, and there is a strict preference ordering:
**self-initiated self-repair > other-initiated self-repair > other-repair.** Speakers get first
right to fix their own trouble, and mid-utterance.

Three transferable properties:

1. **Repair is cheap and local.** You fix the word, not the paragraph. Chat's unit of correction
   is a whole new message — a ~50× cost multiple over what humans do.
2. **Repair is available *during* production.** Not after commitment.
3. **Other-initiation is minimal.** *"The what?"* — one word, targeting the trouble source
   precisely. Chat has no vocabulary for partial trouble; the user must restate wholesale.

> A collaborator you cannot interrupt to correct is one you must fully specify in advance. **The
> absence of repair is what makes prompting feel like programming.** [NOVEL framing]

## 3.4 Joint attention and presence [PRIOR ART: Tomasello; Goffman; Dourish & Bellotti 1992]

What makes a partner feel *present* is not that they talk. It is that they demonstrably share
your attentional situation, continuously, without being asked.

- **Joint attention** — both attending to the same object, and each knowing the other is. This is
  developmentally prior to language in humans and is the substrate reference is built on.
- **Awareness** [Dourish & Bellotti] — in shared workspaces, "an understanding of the activities
  of others which provides a context for your own activity," and critically, it is supplied
  **passively by the shared artifact**, not by explicit notification. Notification-based awareness
  is worse and more expensive. This is the founding result behind Figma-style multiplayer (§4.4).
- **Participation frameworks** [Goffman] — speaker / addressee / overhearer / bystander are
  distinct roles, and a system can be a legitimate *bystander*: present, attending, not addressed.
  Chat has exactly two roles and no way to be present without being addressed.
- **Co-presence without interaction** is the normal state of collaborating humans. Two editors in
  a room may not speak for forty minutes and are unambiguously working together.

> **This is the single most useful import in Part 3.** "Presence" is not warmth, personality, or
> responsiveness. **Presence is continuously visible, accurate evidence of shared attention and
> readiness.** It is achievable without any utterance, and — decisively for ORIS-2 — it can be
> made *entirely honest*, because it reports real state rather than performing feeling.

## 3.5 Initiative, trust, and the long relationship

- **Mixed-initiative** [Horvitz 1999]: initiative is continuous and governed by expected utility,
  including the cost of poorly timed interruption. Enduring; almost never implemented.
- **Interruption cost is structured, not scalar** [PRIOR ART: Bailey & Konstan; McFarlane]:
  interruption at a subtask boundary costs a fraction of interruption mid-subtask. Boundaries are
  observable in an NLE with unusual precision (playback stopped, export queued, panel switched,
  a clip committed).
- **Calibrated trust** [Lee & See 2004]: the goal is not maximal trust but *appropriately
  calibrated* trust. Overtrust and undertrust are both failures. This is the interaction twin of
  the Prediction Ledger and gives a principled reason to surface calibration to the user.
- **Relationships are asymmetric in effort over time.** New collaborators over-explain; mature
  ones use compressed references and long silences. **Explanation frequency declining is the
  observable signature of a working relationship** — which is exactly the expectation-gap
  prediction already in `ORIS_ARCHITECTURE.md` §9.3, arrived at from a different direction.
  Two independent derivations of the same testable claim is the strongest signal in this document.

## 3.6 What does *not* transfer

Stated explicitly so the anthropomorphic trap is avoided:

| Human mechanism | Transfers? | Why / what replaces it |
|---|---|---|
| Eye gaze | **No — and does not need to** | Replaced by something *better*: playhead, selection, viewport, scroll, panel focus are exact, machine-readable attention signals. Gaze is a noisy proxy for what the app knows precisely. [NOVEL framing] |
| Prosody / affect display | **No** — forbidden | ORIS-2. Any affect ORIS displays would be theater |
| Backchannels (*mm-hm*) | **Only if honest** | Permitted only if they report real uptake state; else prohibited (§7.5) |
| Physical co-presence | Partially | Replaced by workspace awareness (§3.4) |
| Social face / politeness | **No** — actively harmful | The persona tax (§2.9) |
| Turn projection | **Yes** | From action completion, not speech |
| Repair | **Yes** — highest value | Requires an incremental channel |
| Grounding / common ground | **Yes** — highest value | ORIS has the substrate |
| Joint attention | **Yes** | Focus state already exists |
| Referential pacts | **Yes** | Requires per-user memory — ORIS has it |
| Preference organisation | **Yes** | Governs *how* to disagree |
| Silence as meaning | **Yes** | `act → ⊥` is already first-class in the calculus |

The asymmetry in this table is the finding: **the mechanisms that don't transfer are the ones
current products imitate (voice warmth, personality, chattiness), and the mechanisms that do
transfer are the ones they ignore (grounding, repair, joint attention, typed silence).**

---

# PART 4 — Patterns from creative software

The relevant question: professionals in creative tools collaborate intensely and converse
sparsely. What carries the load instead?

## 4.1 The artifact is the medium of collaboration

In an edit suite, a mix session, a Houdini scene, a Figma file, or a code review, the shared
object *is* the conversation. Contributions are made **to the artifact** and read **from the
artifact**. Language is used for what the artifact cannot express: intent, taste, constraint,
rationale, and negotiation.

The corollary is the sharpest available criticism of chat-first AI in creative tools: **it moves
collaboration out of the artifact and into a sidebar**, which is precisely backwards from how the
domain has worked for a century.

## 4.2 Non-blocking suggestion — the best-solved interaction problem in software

The spell-check squiggle, the linter warning, the compiler hint, ghost text. Properties:

- **Zero cost to ignore.** No dismissal, no reply, no modal, no guilt.
- **Located at the referent.** The suggestion is *at* the trouble, not in a list about it.
- **Density-scalable.** One or a hundred, the interaction cost per item is constant.
- **Optional escalation.** Hover → explanation → fix → fix-all. Progressive disclosure.
- **Silence when clean.** The absence of squiggles is itself information.

> This pattern is *the* proof that a system can contribute continuously and proactively without
> being annoying — and it does so with no conversation, no persona, and no turn-taking. Any
> claim that "proactive AI is inherently intrusive" is refuted by every IDE ever shipped.

Its limitation is equally instructive: **you cannot argue with a squiggle.** It cannot be asked
why, corrected, or taught. Which is exactly the gap a cognitive partner should fill — and it
argues for *layering* a discursive channel onto an ambient one rather than choosing between them.

## 4.3 Selection + verb + parameters: why generative tools get adopted

Generative Fill, stem separation, content-aware fill, auto-reframe. The grammar is invariably
**select a region → choose a verb → set parameters (of which prose may be one) → get an editable
result.** Professionals adopt these fast and adopt chat assistants slowly. Reasons:

1. Reference is by selection — zero grounding tax.
2. The verb is from a known finite set — no capability guessing.
3. Parameters are direct-manipulable — prose is used only where prose is genuinely better
   (describing content that does not yet exist).
4. **The result lands as an editable object** — a layer, a track, a node. Non-destructive by
   construction.

Point 4 matches Orreris's existing golden rule verbatim (*every AI action is editable and
undoable*, `AI_ARCHITECTURE.md`). The lesson is that this rule is not merely a safety property —
**it is the reason the interaction is cheap**, because reversibility is what makes acceptance a
low-stakes decision, which is what allows the system to propose often.

## 4.4 Multiplayer presence: Figma as the best available model of non-conversational co-presence

Figma multiplayer conveys, continuously and without a word: who is here, where they are looking,
what they have selected, what they are changing right now, and what they changed while you were
away. Collaborators coordinate for hours on this alone.

Two observations:

1. **This is the closest existing implementation of Clark-style grounding levels 1–2 in
   software**, and it is achieved with no natural language whatsoever.
2. **Figma's AI does not participate in it.** The AI is in a panel; the presence system is on the
   canvas. The single most obvious unexplored design in the entire survey is an AI participant
   that is *in* the presence model — with a viewport, a selection, and an attention state that
   the human can read at a glance. [NOVEL, and cheap to state; §5 candidate E.]

The caveat, recorded honestly: a second cursor that moves on its own may read as unsettling
rather than collaborative, and multiplayer presence between humans carries social contracts an
AI does not inherit. This is a genuine unknown (Part 9, Q4).

## 4.5 The assistant editor — the role the domain already defined [NOVEL application]

Post-production has spent decades refining the division of labour between an editor and an
**assistant editor**. The assistant: ingests, transcodes, syncs, logs, groups, builds string-outs,
prepares selects, conforms, tracks continuity, and keeps the project organised. The assistant
does **not** decide the cut.

The interaction properties of that role are remarkable and are almost the inverse of a chatbot:

| Property | Assistant editor | Chat assistant |
|---|---|---|
| Primary contribution | **Preparation** — work done ahead of need | Response — work done on demand |
| Initiative | High, but only on self-directed work | Zero |
| Interruption | Rare, batched, at boundaries | On every turn |
| Taste authority | None, by convention | Implicitly claimed every turn |
| Value delivered when idle | Very high | Zero |
| Trust basis | Reliability over months | Per-response plausibility |

This maps onto ORIS-1 with almost no adaptation: *the organism acts freely on itself and never on
the user's work.* Everything an assistant editor does is either self-directed preparation or a
user-authorised action. **The role is a pre-existing, professionally validated interaction
contract for exactly the invariant ORIS already committed to** — and it locates the highest-value
contribution somewhere chat cannot reach: work that is *already done* when you arrive.

## 4.6 Other domains, briefly

- **DAWs (Ableton/Pro Tools).** Interaction is real-time and parallel; there are no turns. The
  "jam" model: contribute into a running loop, evaluate by listening, keep or discard. Suggests
  proposal-by-doing-in-parallel rather than proposal-by-describing.
- **Node graphs (Nuke/Houdini/Flarex).** The graph is an externalised shared representation you
  can argue about precisely. Orreris already has this. A proposal expressed as a *sub-graph* is
  inspectable, diffable, partially acceptable, and explains itself structurally — a far richer
  proposal medium than prose. Highly relevant given Flarex.
- **Version control / code review.** The review comment is the most successful asynchronous
  collaboration primitive ever built: **anchored to a location, asynchronous, batched,
  optionally resolvable, and non-blocking.** Threaded review comments on a timeline region are a
  more natural fit for editorial feedback than a chat log, and they solve batching for free.
- **Writing environments.** Track changes / suggestion mode is the same primitive: a proposal
  that lives *in* the document but is not yet the document. This is F4's ancestor and it predates
  computing (the margin annotation).
- **Pair programming.** Driver/navigator: continuous shared attention, asymmetric roles that
  swap, and long silences punctuated by short, deictic contributions ("no, up there"). The
  navigator's contributions are overwhelmingly *pointing plus a short phrase* — which is precisely
  the message type chat is worst at and a workspace-anchored channel is best at.

## 4.7 The synthesis of Part 4

Across every creative domain, the recurring collaboration primitive is not the message. It is:

> **an anchored, reversible, inspectable proposal, made in or on the artifact, that costs
> nothing to ignore.**

Squiggle, ghost text, track change, review comment, suggestion layer, diff, string-out, node
branch. Eight domains, one primitive. **Chat is the only surface in the survey that is not this**,
and it is the only one the AI industry uses by default.

---

# PART 5 — Candidate interaction models

Ten candidates, evaluated before any recommendation. Each is stated as an *architecture*, not a
UI. Evaluation criteria, fixed across candidates:

- **G · Grounding cost** — effort to establish the referent
- **I · Initiative fit** — can the system contribute at the right times?
- **X · Interruption cost** — what an unwanted contribution costs the user
- **T · Trust/verifiability** — can the user check it before it matters?
- **D · Determinism fit** — compatibility with the editor's replayable core
- **E · Evidence yield** — scoreable outcomes per interaction (§2.8)
- **B · Band coverage** — how many of the seven ORIS bands it can serve (§7.1)
- **R · Relationship depth** — can a multi-year relationship accumulate in it?

Scored `▲ strong · ● adequate · ▽ weak`.

## Candidate A — Chat-first (status quo)

Prose transcript as the primary channel; system responds; user routes.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| ▽ | ▽ | ▽ | ● | ● | ▽ | ▽ | ▽ |

**Strength:** universal, zero learning curve, unbounded expressivity, excellent for the message
types nothing else handles (explanation, teaching, negotiation, why-questions).
**Fatal weakness:** every failure in Part 2. Serves one band. Starves the ledger.
**Verdict:** cannot be the architecture. Has a real and defensible role *within* one (§10.2).

## Candidate B — Voice-conversational (realtime duplex)

Speech as the primary session channel; VAD or predictive floor allocation.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| ▽▽ | ● | ▽ | ▽ | ● | ▽ | ▽ | ▽ |

**Strength:** hands/eyes free — genuinely valuable when eyes are on the picture; the only channel
that carries nuance and hesitation; excellent for taste negotiation.
**Fatal weakness:** worst grounding of any candidate (§2.6b); unverifiable before commitment;
half-duplex against full-duplex work; ORIS-2 forbids the presence tricks the field uses.
**Verdict:** cannot be the architecture. A strong *channel* for specific message types.

## Candidate C — Intent line / command channel (F5)

Language as a one-shot imperative against the current selection. No persona, no history,
dismissed on completion.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| ● | ▽ | ▲ | ▲ | ▲ | ● | ▽ | ▽ |

**Strength:** honest about what most requests are (§2.2 — the repo's own corpus is dominated by
transactional commands). Zero persona tax. Perfect fit with the tier-0/1 cascade. Ephemeral by
design.
**Weakness:** zero initiative; no relationship substrate; explicitly stateless.
**Verdict:** an excellent *component*. It is the correct home for the traffic that currently
wastes chat. Not an architecture — it deliberately forecloses everything ORIS is for.

## Candidate D — Inline proposal / ambient annotation (F3)

Contributions are anchored, non-blocking annotations on the artifact: on a clip, a region, a
transition, a node, a track. Accept / ignore / ask-why.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| ▲ | ● | ▲ | ▲ | ▲ | ▲ | ● | ● |

**Strength:** solves grounding (anchored), interruption (zero ignore cost), and evidence yield
(accept/reject/edit is a labelled pair) simultaneously — the three hardest criteria. Proven across
eight domains (§4.7). Density-scalable.
**Weakness:** cannot carry explanation, teaching, or negotiation; risks becoming visual noise;
"ask why" needs somewhere to go, i.e. it *requires* a discursive channel to escalate into.
**Verdict:** the strongest single candidate on the criteria that matter most, and structurally
incomplete alone.

## Candidate E — Workspace co-presence (Figma-style participant)

ORIS occupies the workspace as a participant with observable state: what it is attending to, what
it has prepared, what it is uncertain about, what it is currently costing. No utterance required.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| ▲ | ● | ▲ | ● | ▲ | ▽ | ▲ | ● |

**Strength:** the only candidate that delivers Clark levels 1–2 (attention, identification)
continuously and honestly. Directly satisfies "presence" without theater — because everything
displayed is *real state* (ORIS-2-safe by construction). Covers bands B0–B1, which no other
candidate touches. Makes interoception a *product surface* rather than a HUD.
**Weakness:** produces almost no evidence on its own — it is a display, not an exchange. Possible
uncanniness (§4.4). Cost of always-on observation must respect ORIS-6.
**Verdict:** the missing layer in every system surveyed, and the answer to "why doesn't it feel
present." Not an interaction architecture by itself — it is the *substrate* one runs on.

## Candidate F — Preparation / assistant-editor model

ORIS's primary contribution is work completed ahead of need — analysed, indexed, warmed, grouped,
strung out, conformed — surfaced as *availability*, not as proposals.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| ▲ | ▲ | ▲ | ▲ | ▲ | ● | ● | ▲ |

**Strength:** delivers value with **zero interaction cost** — the only candidate that does. Fits
ORIS-1 exactly (all self-directed). Fits the free-running cycle's need for a reason to tick.
Trust accrues from reliability rather than from per-response plausibility, which is how
professional trust actually works. Domain-validated for decades (§4.5).
**Weakness:** invisible when it works, so it is hard to attribute value to; evidence yield is
indirect (did they use what was prepared?); can prepare the wrong things expensively.
**Verdict:** badly underrated, and probably the highest value-per-unit-annoyance of any candidate.
Almost nothing in the industry does this.

## Candidate G — Mixed-initiative arbitration (Horvitz, operationalised)

Not a surface but a **policy layer**: a continuous decision over {act · propose · ask · speak ·
wait}, computed from expected utility, interruption cost, and the expectation gap.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| — | ▲ | ▲ | ● | ▲ | ▲ | ▲ | ▲ |

**Strength:** the correct answer to "should ORIS wait / interrupt / observe / ask / suggest /
teach / challenge / stay silent" — it makes that a computed variable rather than a design opinion.
Every input it needs already exists in the ORIS design.
**Weakness:** not an interaction surface — it *selects among* surfaces and therefore presupposes
several. Miscalibration here is highly visible and expensive (a wrongly-timed interruption is a
T3 error that users experience as a T0 betrayal).
**Verdict:** required, and orthogonal to A–F. This is the governor, not the vehicle.

## Candidate H — Proposal-as-branch (graph/sandbox mediation)

ORIS works in a sandboxed copy — a proposal composition, a Flarex sub-graph, an alternate version
— which the user reviews, diffs, partially accepts, or discards.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| ▲ | ▲ | ● | ▲ | ▲ | ▲ | ● | ● |

**Strength:** highest verifiability of any candidate — the deterministic renderer makes a proposal
*exactly* previewable (`ORIS_ARCHITECTURE.md` §8: the environment is a pure function). Partial
acceptance yields the richest possible evidence: not accept/reject but a per-component delta.
Naturally supports long-horizon autonomous work without touching the user's work — a literal
reading of ORIS-1.
**Weakness:** review has real cost (unlike D's zero); heavier interaction; risks the "here is a
wall of changes" failure that plagues F4 agents.
**Verdict:** the right architecture for *large* contributions. Wrong for small ones. Pairs with D
by contribution size.

## Candidate I — Critique / dailies review

Asynchronous, batched, anchored critique delivered at natural boundaries — the editorial
equivalent of code review, at the cadence of a dailies session.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| ▲ | ● | ▲ | ▲ | ▲ | ● | ● | ▲ |

**Strength:** batching solves interruption structurally rather than by policy. Matches the real
rhythm of editorial work. The only candidate that naturally carries *teaching* and *challenge* —
the ORIS-3 anti-sycophancy obligations — because critique is an accepted genre with existing
professional norms for disagreement.
**Weakness:** slow band only (B2–B3); useless for the moment-to-moment; requires the system to be
right about a lot at once, which raises the stakes per contribution.
**Verdict:** the natural home for the slow bands, and the only surface in the survey where "ORIS
disagrees with you" is socially legible.

## Candidate J — Full agent delegation

Describe an outcome; the system pursues it over a long horizon with checkpoints.

| G | I | X | T | D | E | B | R |
|---|---|---|---|---|---|---|---|
| ▽ | ▲ | ▽ | ▽ | ● | ▽ | ▽ | ▽ |

**Strength:** highest ceiling per request; the only model for genuinely long tasks.
**Fatal weakness for this product:** it removes the human from the loop, which for a *craft* tool
removes the point. Evidence yield collapses (one outcome per hour of work). Verifiability is
poor. It is also in direct tension with ORIS-3 — a user who delegates does not grow.
**Verdict:** the industry's current fashion and the worst fit here. Should be available for
bounded, self-directed, non-authored work only (i.e. what Candidate F already covers, honestly).

## 5.1 Cross-candidate observations

**Observation 1 — no candidate covers more than three bands.** Every one has a natural cadence and
degrades badly outside it. This is the empirical route to §7.1's claim.

**Observation 2 — the criteria cluster into two groups that trade off.**
`{G, X, E}` (grounding, ignorability, evidence) are maximised by *anchored, small, reversible*
contributions. `{R, teaching, negotiation}` are maximised by *discursive, slow, prose* ones. No
single surface maximises both, and pretending otherwise is what produced chat-as-everything.

**Observation 3 — the top-scoring candidates are the ones the industry least uses.** D scores well
and exists only as dumb autocomplete; E exists between humans but never for AI; F exists in human
post-production and nowhere in software. J scores worst and receives most of the field's
investment. That asymmetry is either a large opportunity or evidence that we are missing a
constraint the industry has learned about — Part 9 Q7 records this as a genuine open question and
not a rhetorical one.

**Observation 4 — G is not a surface and must not be confused for one.** Several plausible-sounding
"new interaction paradigms" are really G wearing a costume. The useful decomposition is
**substrate (E) → surfaces (C, D, F, H, I, A, B) → governor (G)**.

## 5.2 The models deliberately *not* proposed

Recorded so their absence is a decision, per house convention.

- **A new modality** (gesture, gaze, EEG, spatial). Nothing in Part 2 is a modality problem. Adding
  a modality to an unfixed architecture reproduces §2.6.
- **An avatar / embodied persona.** ORIS-2 forbids it and §2.9 shows it is a cost even when
  permitted.
- **A "canvas" the AI and user co-draw on.** Orreris already has one — it is called the timeline.
  A second shared space is the sidebar problem with extra steps.
- **Autonomy sliders.** Makes the human the router (§2.7) while appearing to fix it.
- **A memory-management UI.** Making the user curate the AI's memory outsources the architecture's
  hardest job to the person least able to do it.

---

# PART 6 — Interaction principles

Distilled to survive the current technology generation. Numbered `IX-n` for citation, in the style
of the ORIS invariants, and deliberately stated so each is falsifiable or at least violable.

**IX-1 · The artifact is the referent.** Interaction is anchored to objects in the work — a clip,
a region, a node, a frame range — not to positions in a transcript. Anything that can be pointed
at must never be described.

**IX-2 · Never re-derive what the system already knows.** If focus state, selection, playhead, or
project history determines the referent, the interaction must consume it directly. A surface that
makes the user restate known state is charging rent on its own ignorance.

**IX-3 · The cost of ignoring a contribution must approach zero.** This is the property that
permits proactivity. A contribution requiring dismissal is an interruption regardless of quality;
a contribution requiring a reply is a conversation the user did not agree to start.

**IX-4 · Initiative is a continuous variable, computed — never a mode the user selects.** If the
human must choose the autonomy level per request, the system has delegated its arbitration to the
person with the least information about its confidence.

**IX-5 · Silence is a contribution and must be typed.** Withholding is an act with a reason
(low confidence, small expectation gap, high interruption cost, body pressure). The calculus
already makes `⊥` a first-class output of `act`; the interaction layer must be able to represent
*why* it was chosen, on request.

**IX-6 · Every contribution must resolve to a scoreable outcome.** A surface that emits no
accept/reject/modify signal cannot feed a prediction ledger and therefore cannot participate in
the system's development. Evidence yield is a first-class interaction requirement, not a
telemetry afterthought.

**IX-7 · Presence is honest state, continuously visible — never performed.** Attention, readiness,
uncertainty, cost, and preparedness are real quantities. Displaying them is presence; simulating
warmth is theater (ORIS-2).

**IX-8 · Repair must be cheaper than restatement.** Both directions: the user must be able to
correct a contribution *in place*, and the system must be able to narrow, hedge, or withdraw one
before it commits.

**IX-9 · Contributions are proposals until the human commits them.** Proposal and execution are
distinct events, and reversibility is what makes acceptance cheap enough to offer often. (Already
law in the habitat; restated here because it is *also* an interaction property, not only a safety
one.)

**IX-10 · Explanation is a function of the expectation gap, and should decline over time.** A
system explaining at a constant rate after a year is not modelling the relationship. Directly
testable (IH-4).

**IX-11 · Modality is a property of the message, not of the session.** Voice for negotiation and
eyes-on-picture; anchored annotation for reference; prose for rationale; the artifact for
proposals. Sessions that lock a modality force every message through the wrong channel some of
the time.

**IX-12 · Interrupt at boundaries, never mid-unit.** Boundaries in an NLE are observable with
unusual precision. This single rule recovers most of the interruption-cost literature.

**IX-13 · Effort must be visible.** Cost signals — route, latency class, body pressure — are
social information that calibrate the user's asking. Hiding them forces users to build
superstitions.

**IX-14 · The tool must be complete without the partner.** Every capability reachable by the
human alone. Not merely a safety stance: it is what keeps the interaction *optional*, and optional
partners are the ones people trust.

**IX-15 · Prepared work beats offered work.** The highest-value contribution is one that is
already done when the user arrives at the need. It costs zero interaction and accrues trust
through reliability rather than persuasion.

**IX-16 · Disagreement needs a genre.** A system obliged to challenge the user (ORIS-3) must have a
surface where challenge is socially legible — critique, review, a second opinion — rather than
contradiction injected into a task flow. Otherwise correctness reads as insubordination and the
user turns it off.

---

# PART 7 — Architectural implications for ORIS

## 7.1 The band ladder predicts the interaction surfaces [NOVEL — the central result]

`ORIS_TIME.md` §2 defines seven bands, each with a period and a reach, and constrains reach ≈ k ×
period. Interaction is subject to the same physics: **a contribution's natural surface is
determined by the band of the cognition that produced it.** Mapping the two ladders:

| Band | Period | Cognition that lives there | Natural interaction cadence | Candidate that fits | What chat does to it |
|---|---|---|---|---|---|
| **B0** somatic | ~16 ms | interoception, health | continuous, non-verbal, peripheral | **E** (presence) | cannot represent it at all |
| **B1** situational | 1–5 s | workspace, attention, core self | continuous ambient + immediate anchored | **E**, **D**, **C** | forces a turn for a glance |
| **B2** task | min–hours | intentions, episodes | anchored proposals; occasional prose | **D**, **H**, **A** | the one band chat actually fits |
| **B3** project | days–weeks | project beliefs, client norms | batched review at boundaries | **I**, **F** | buries it in scrollback |
| **B4** dispositional | months | skills, habits, user model | rare, on-demand, inspectable | **I** + inspection | no representation |
| **B5** identity | years | commitments, refusals | ceremonial, rare, announced | announcement + provenance | no representation |
| **B6** constitutional | never | operators, values | documentation | — | — |

Three consequences:

1. **Chat serves exactly one of seven bands** and is actively harmful in three (B0, B1 by forcing
   turns; B3–B4 by burying slow-band content in a fast-band transcript). This is a precise
   statement of the diffuse complaint that chat "doesn't feel like a partner": six sevenths of
   the partner has nowhere to appear.
2. **ORIS-13 constrains the interaction layer too.** *No operator writes to a band slower than its
   own.* The interaction analogue: **a fast-band exchange must not be able to write slow-band
   state.** A user saying "no, warmer" once is a B1/B2 event and must not become a B4 disposition —
   yet "the AI remembered my preference from one message" is exactly what most agent-memory
   products ship, and it is why they oscillate. The band ladder, applied to interaction, forbids
   the industry's most common memory feature. That is a strong, non-obvious, and checkable result.
3. **Reach ≈ k × period applies to contributions.** A contribution about the next year should not
   arrive at frame cadence, and a contribution about this frame should not arrive weekly. Any
   proposed surface whose cadence and scope are mismatched by orders of magnitude is, per
   `ORIS_TIME.md` §2.1, almost certainly two surfaces.

## 7.2 The eight phases locate the interaction seams

`ORIS_CALCULUS.md` §2 gives the loop: `sense → bind → believe → expect → act → compare →
attribute → adapt`. The interaction layer touches it at exactly four points, and naming them
prevents the usual sprawl:

| Phase | Interaction seam | Requirement it imposes |
|---|---|---|
| ① `sense` | The user's *actions* are observations, not just their words | The interaction layer must emit witnessed events (ORIS-18/19): selection changed, scrubbed, undid, exported — never "user seemed frustrated" |
| ② `bind` | Shared attention | The situation σ must be *readable by the user*. This is Candidate E's formal justification: presence is σ, displayed |
| ⑤ `act` | **The speak/act/wait decision** | `act: P × C × D × Θ → α ǀ ⊥`. The interaction architecture is the *codomain* of this operator. `⊥` must be expressible and, on request, explainable (IX-5) |
| ⑥ `compare` | Outcome capture | The surface must produce the outcome that scores the prediction (IX-6). A surface with no outcome makes ORIS-4 unenforceable |

> **The load-bearing observation:** `act` already has "wait" as a first-class output, and already
> takes commitments `C` (which may veto) and drives/body `Θ` as inputs. **The mixed-initiative
> governor of Candidate G is not a new subsystem — it is the `act` operator, given a richer
> codomain than {timeline mutation, chat message}.** That is a rejection of a plausible new box
> under `ORIS_CALCULUS.md` §5, and the correct kind of result: the interaction architecture needs
> *no new operators*.

## 7.3 The expectation gap is the interaction arbiter — extended

`ORIS_ARCHITECTURE.md` §9.3 defines `gap = divergence(what ORIS will do, what ORIS believes the
user expects it to do)` and uses it to decide when to explain. The interaction investigation says
it generalises: the gap plus confidence plus interruption cost selects the **channel**, not merely
whether to speak.

```
gap small,  confidence high            → act (or prepare silently)     ← Candidate F
gap small,  confidence low             → anchored proposal, no prose   ← Candidate D
gap large,  confidence high            → proposal + rationale          ← D escalating to A
gap large,  confidence low             → ask — and ask narrowly        ← C or A
gap large,  stakes high, time is not   → batch to a review boundary    ← Candidate I
any gap,    interruption cost high     → ⊥ (wait), with the reason retained
```

This is a decision procedure over existing state variables. It is not a UI, and it deliberately
stops before saying what any of these look like.

## 7.4 The value hierarchy already contains an interruption policy

`ORIS_VALUES.md` ranks **timing** as T3 (fluency), below intent (T1) and craft/calibration (T2),
above efficiency (T4). Three rulings drop out without further argument:

1. **Never interrupt to be fast.** T3 over T4 means a correct-but-late contribution outranks a
   fast-but-intrusive one. Latency is the cheapest thing to sacrifice.
2. **Never stay silent to avoid interrupting when intent is at stake.** T1 outranks T3. If ORIS
   believes the user has misread their own intent in a consequential way, timing does not license
   silence. This is the anti-sycophancy obligation given a concrete interaction rule.
3. **Interruption is a *typed* error, so it is attributable.** A badly-timed contribution produces
   a Timing error in `compare`, attributable in `attribute`, and adaptable in `adapt`. **The
   interruption policy is therefore learnable per user through the existing loop** — which is
   exactly what the mixed-initiative literature has always required and never had a substrate for.

Additionally, the values doc's ruling that *"the scope of legitimate autonomy is exactly the scope
of achievable explanation"* is, read as interaction design, a hard constraint on Candidates F, H
and J: **ORIS may work ahead only as far as it could account for the work afterwards.**

## 7.5 What ORIS-2 forbids, precisely

The no-theater invariant is more constraining on interaction than on cognition, and it should be
stated exactly so it is not over- or under-applied:

| Move | Permitted? | Reason |
|---|---|---|
| Displaying real attention (what it is looking at) | **Yes** | Honest state |
| Displaying real uncertainty | **Yes** | Honest state; supports calibrated trust |
| Displaying real load/cost | **Yes** | Honest state; effort signal (IX-13) |
| Typing indicator when actually computing | **Yes** | It is true |
| Typing indicator as engagement device | **No** | False state |
| Backchannel (*mm-hm*) meaning "uptake registered" | **Conditional** | Only if it reports real uptake, and only if the user reads it as status rather than affect. Genuinely uncertain — Part 9 Q5 |
| Simulated hesitation, warmth, enthusiasm | **No** | Theater |
| A face, an avatar, a name spoken in first person about feelings | **No** | Theater |
| "I'm not confident here — I've been wrong on this footage class twice" | **Yes** | Telemetry, and the ledger makes it true |

The consequence worth naming: **ORIS must achieve presence without any of the affective devices
the field currently uses.** §3.4 is the argument that this is possible — presence is shared
attention made visible, not warmth — and it is the reason Candidate E matters disproportionately
here. This is a constraint that turns out to select the better design.

## 7.6 Interaction events are observations, not interpretations

ORIS-19 applies with full force and rules out the entire industry practice of "feedback capture."
The interaction layer may record: *proposal shown at t*, *accepted at t+3.1 s*, *saturation
subsequently changed by −12*, *undone at t+40 s*, *panel closed*. It may **not** record: *user
liked it*, *user was frustrated*, *user is a beginner*. Those are functions over events, computed
at read time, by a named and versioned policy (ORIS-20).

This has a sharp practical implication: **thumbs-up/thumbs-down widgets are architecturally
prohibited** as *evidence*, because a rating is an interpretation with no witnessed event behind
it beyond "a button was pressed." The button-press is recordable; "the user approved" is derived.
The distinction sounds pedantic and is not: it is the difference between a corpus you can re-derive
conclusions from when your policy improves, and one that has baked a 2026 opinion into permanent
storage.

## 7.7 Interaction is subject to the body budget

ORIS-6 without amendment: an interaction surface that costs frame time is a starvation regression
wearing new clothes, and this repo's history is largely a history of starvation bugs. Practical
consequences: continuous presence rendering belongs on the somatic band with a strict budget;
speech I/O is a heavy always-on cost and must be summonable rather than resident; proposal
computation is background-gated exactly like proxy builds and is cancellable.

There is a second-order effect worth recording: **body state is itself the honest reason to be
quiet.** A system that visibly contributes less while the machine is under load is not degraded —
it is legible, and legibility is what the interruption literature says users actually want.

## 7.8 What ORIS has that no surveyed system has

Summarised, because it is the case for not inheriting the industry's architecture:

| Requirement of a good interaction architecture | Who has it |
|---|---|
| A precise, continuous attention signal (playhead/selection/viewport) | Any NLE — but no NLE's AI uses it |
| Calibrated confidence to gate initiative | ORIS (ledger). Essentially nobody else |
| A memory of past interruption outcomes | ORIS (experience stream) |
| A model of what the user expects it to do | ORIS (level-2 theory of mind, §9.3) |
| A deterministic simulator to make proposals exactly previewable | **ORIS, uniquely** (§8) |
| Reversibility as a system invariant | Orreris (registry) |
| A body whose state is an honest reason to be quiet | ORIS (interoception) |
| A band ladder to keep fast events out of slow memory | ORIS (ORIS-13) |

Seven of eight are prerequisites the mixed-initiative literature has demanded since 1999. **The
reason nobody ships Horvitz's principles is that nobody has had these. ORIS has them before it has
an interaction architecture — which is the unusual and favourable position this investigation
exists to exploit.**

---

# PART 8 — Research hypotheses

Stated in the style of `ORIS_RESEARCH_PROGRAMME.md`: falsifiable, with a metric, a prediction, and
a kill criterion. Several are measurable against corpora that already exist, which makes them
cheap and therefore the correct first moves.

**IH-1 · The grounding-tax hypothesis.** A substantial fraction of user composition effort and
model tokens in the existing corpus is spent re-establishing referents the focus state already
holds.
*Metric:* over `AI_REFINEMENT.md` + the 50-prompt ledger, the fraction of request tokens
occupied by referring expressions resolvable from selection/playhead/panel state at request time.
*Predicted:* > 35 %. *Kill:* < 15 %, which would mean the grounding argument is overstated and
Part 2's central claim is wrong.

**IH-2 · The evidence-yield hypothesis.** Anchored proposals (D) produce materially more
ledger-scoreable outcomes per minute of user attention than chat (A).
*Metric:* scored predictions per user-minute, and fraction of contributions with a resolved
outcome within 10 minutes. *Predicted:* ≥ 5× on both. *Kill:* < 1.5×.

**IH-3 · The withholding hypothesis.** Suppressing contributions when the expectation gap is small
*increases* the acceptance rate of the remainder without reducing total accepted value.
*Metric:* accepted-contributions-per-session and acceptance rate, gap-gated vs ungated.
*Predicted:* acceptance rate up materially, accepted volume flat or up. *Kill:* accepted volume
falls — i.e. the gap is not a good filter and volume was doing the work.

**IH-4 · The explanation-decay hypothesis.** [Already predicted in `ORIS_ARCHITECTURE.md` §9.3;
restated here as an interaction claim.] For a given user, the rate at which ORIS must explain
itself declines monotonically over months, and *forcing* it flat degrades measured efficiency.
*Metric:* explanation events per accepted contribution over time. *Kill:* flat or rising after six
months of use, which would falsify the level-2 theory-of-mind story.

**IH-5 · The preparation hypothesis.** [NOVEL, and the most product-consequential.] Work completed
ahead of need (F) is valued more highly per unit of ORIS compute than suggestions offered on
demand (D), and is more trust-building per unit of user time than either D or A.
*Metric:* utilisation rate of prepared artifacts; trust-calibration change; user-time-to-outcome.
*Kill:* prepared work goes unused > 70 % of the time, which would mean ORIS cannot predict need
well enough for the assistant-editor model and Candidate F collapses into speculative waste.

**IH-6 · The projection hypothesis.** Turn transition predicted from *action* completion (playback
stopped, edit committed, selection settled, panel switched) outperforms silence-based detection on
both false-interrupt rate and response latency.
*Metric:* false interruptions per hour; median time from user-ready to system-contribution.
*Kill:* action-based projection is not better than a well-tuned fixed delay — which would mean
§2.6a's argument is theoretically right and practically irrelevant.

**IH-7 · The honest-presence hypothesis.** Presence conveyed purely by real state (attention,
readiness, uncertainty, load) produces subjective partner-presence comparable to affective
devices, without their cost.
*Metric:* social/co-presence instruments (Networked Minds or equivalent), plus interruption
tolerance. *Kill:* honest-state presence scores no better than a static indicator, which would
mean presence genuinely requires affect and ORIS-2 permanently caps how present ORIS can feel.
**This is the hypothesis whose failure would hurt most**, and it should be tested early precisely
for that reason.

**IH-8 · The band-leak hypothesis.** Systems that write fast-band events into slow-band memory
(the industry's standard "I'll remember that") produce measurably worse long-run behaviour —
oscillation, contradictory preferences, user-perceived unpredictability — than systems that
enforce ORIS-13.
*Metric:* preference-flip rate; contradiction accumulation; override rate over months. Testable by
ablation against ORIS's own band enforcement. *Kill:* no measurable difference over a year, which
would make the ladder an unnecessary constraint on interaction.

**IH-9 · The message-modality hypothesis.** Assigning modality per message type outperforms
session-level modality on task completion and error rate.
*Metric:* per-message-type error rates and completion times, matched. *Kill:* users prefer a
consistent single modality even at measurable cost — a plausible and important negative result.

**IH-10 · The chat-ablation hypothesis.** [The decisive one.] A large fraction of the existing
request corpus can be served with *no prose channel at all* — via selection + verb, anchored
proposal, or prepared artifact.
*Metric:* classify the full corpus by minimum sufficient channel. *Predicted:* > 60 % need no
prose; < 15 % genuinely require discursive language (explanation, teaching, taste negotiation,
why-questions). *Kill:* > 40 % require prose, which would substantially rehabilitate chat as a
primary surface and force a rewrite of Part 10.

**IH-11 · The interruption-boundary hypothesis.** Contributions delivered at observable task
boundaries cost measurably less than identical contributions delivered mid-unit.
*Metric:* resumption lag and error rate after contribution, boundary vs mid-unit. *Predicted:*
large effect, consistent with the interruption literature. *Kill:* no effect, which would mean
NLE task boundaries are not real cognitive boundaries.

**IH-12 · The persona-tax hypothesis.** Removing conversational persona framing (name, avatar,
first-person social language) *increases* correction rate and decreases abandonment.
*Metric:* rate at which users correct/contradict the system; mid-task abandonment. *Kill:*
persona removal reduces engagement without improving correction, meaning the social frame is
load-bearing after all.

---

# PART 9 — Open questions

Honest unknowns, recorded so they are not mistaken for settled. Several are *product* questions
this document should not answer from the armchair.

**Q1 · Where does prose remain irreplaceable?** IH-10 measures the volume, not the boundary. The
strong candidates for irreducible prose are explanation, teaching, negotiation of taste,
disagreement, and questions about *why*. Whether that set is small and stable, or whether it
expands as the partner gets more capable, is unknown and matters enormously.

**Q2 · How is ORIS addressed when it is not already attending?** Human collaboration has summons —
name, gaze, touch, a raised head. A resident that is always listening is a privacy and
body-budget cost; one that must be invoked is not a resident. The summons mechanism is
under-theorised in this document and is probably its largest gap.

**Q3 · How does a user disagree with a system that has commitments?** ORIS is designed to hold
refusals with provenance (ORIS-11) and to challenge rather than flatter (ORIS-3). The interaction
grammar for *arguing with the tool* has no precedent in creative software, and getting it wrong in
either direction — insubordination or capitulation — destroys the product.

**Q4 · Is an AI participant in a presence model uncanny?** §4.4's caveat. Multiplayer presence
between humans carries social contracts (they are a person, they will notice you noticing) that an
AI does not inherit. A self-moving second cursor may read as surveillance rather than partnership.
This is testable and untested.

**Q5 · Are honest backchannels possible?** §7.5 leaves this conditional. A signal meaning "uptake
registered" is honest state, but users may read *any* backchannel affectively, in which case
honest intent produces theatrical reception — and ORIS-2 is about what the user experiences, not
what we intended.

**Q6 · What is the right batching cadence for slow-band contributions?** Candidate I depends on it
entirely. Editorial has natural rhythms (dailies, cut screenings, delivery) but a solo creator on
a browser NLE may have none.

**Q7 · Is the industry's neglect of D/E/F evidence of a constraint we have not found?** §5.1
Observation 3. The charitable reading is that these require persistence and calibration that only
ORIS has. The uncharitable reading is that they were tried and users hated them, and we have not
found that evidence. Worth a deliberate search before committing.

**Q8 · Does the resident model fit intermittent use?** ORIS assumes long-running presence. A
freelancer who opens the app twice a month may find a "resident" that has been living in their
project without them uncanny rather than helpful — and the accumulated preparation may be stale.

**Q9 · Who is present in a multi-user installation?** Directly inherits `ORIS_ARCHITECTURE.md` §20
Q7 (per-install / per-user / per-relationship identity). Interaction makes it sharper: if two
editors share a workstation, whose attention is ORIS sharing, and does it say different things to
each? Unresolved, and it interacts hard with ORIS-7 and ORIS-16.

**Q10 · How much interaction bandwidth does the observation itself cost the user?** Every presence
signal occupies visual attention that the picture needs. Editors stare at frames for a living. A
presence layer competing with the image is a craft cost (T2) masquerading as a fluency gain (T3),
and the value hierarchy says that trade is a loss.

**Q11 · Can the interaction architecture be evaluated before the organism exists?** Most of Part 8
presumes a working ledger and calibration. If interaction must be designed first and cognition
second, several hypotheses cannot be tested in the order the build requires. The sequencing in
§10.4 is a guess at this and should be treated as one.

---

# PART 10 — Recommendations

## 10.1 The direct answer to the question as posed

The brief asks whether ORIS should continue with chat, voice, multimodal collaboration, shared
workspace, ambient presence, mixed initiative, or something fundamentally new. The answer is that
**the list is a category error, and recognising that is the recommendation.** Four of those seven
are not alternatives to each other:

- *Shared workspace* is a **substrate**.
- *Ambient presence* is a **property** of that substrate being made visible.
- *Mixed initiative* is a **governor**.
- *Chat*, *voice*, and *multimodal* are **channels**.

> **Recommendation R0:** stop treating interaction as a choice of surface, and adopt the
> decomposition **substrate → surfaces → governor**. Almost every failure in Part 2 comes from
> a system that has only a channel and calls it an architecture.

## 10.2 The recommended architecture, in one paragraph

**Not chat. Not voice. Not something fundamentally new.** A layered architecture in which
**shared workspace state is the substrate** (Candidate E — presence as honestly displayed
situation σ); **anchored, reversible proposals in the artifact are the default surface**
(Candidate D, escalating to Candidate H for large contributions); **preparation is the primary
mode of contribution** (Candidate F, and the highest-value one); **batched critique carries the
slow bands** (Candidate I); **an intent line carries transactional commands** (Candidate C, which
is what most current chat traffic actually is); **prose and voice are retained as channels for the
message types that genuinely require them** (Candidates A and B, demoted from architecture to
channel); and **the `act` operator, extended to a richer codomain, is the governor** (Candidate G,
requiring no new subsystem per §7.2).

Nothing here is novel as a *set of surfaces*. What is novel is the claim that **the assignment of
surface to band is not a design preference but is determined by the cognitive architecture already
committed to** (§7.1), and that ORIS is the first system with the prerequisites to run the
governor honestly (§7.8).

## 10.3 Specific dispositions

| Surface | Disposition | Justification |
|---|---|---|
| **Chat** | **Demote, do not remove.** Cease to be the default; become the escalation target for *why*, teaching, taste negotiation, and disagreement | Part 2 (eight failures); IH-10 predicts < 15 % of traffic needs it; §5 Candidate A is genuinely strong at exactly that residue |
| **Voice** | **Demote to a channel; keep.** Summonable, message-typed, not a session mode | §2.6 — the failure is voice-as-session, not voice; IX-11 |
| **Anchored proposal** | **Promote to default surface** | Best scores on G/X/E (§5 D); eight-domain precedent (§4.7); feeds the ledger |
| **Preparation** | **Promote to primary contribution mode** | IX-15; §4.5's professionally validated role; exact fit with ORIS-1; only surface with zero interaction cost |
| **Presence** | **Introduce as substrate** | §3.4; the answer to "why doesn't it feel present"; ORIS-2-safe because it is real state |
| **Intent line** | **Introduce** | Absorbs the transactional traffic the repo's own corpus is dominated by; zero persona tax |
| **Batched critique** | **Introduce for B3–B4** | The only surface where ORIS-3 challenge is socially legible (IX-16) |
| **Full delegation** | **Do not pursue as a headline mode** | §5 Candidate J; anti-correlated with ORIS-3; poor evidence yield |
| **Avatar / persona / affect** | **Prohibit** | ORIS-2; §2.9 persona tax |
| **Autonomy sliders / mode pickers** | **Prohibit** | IX-4; makes the human the router |
| **Thumbs up/down feedback** | **Prohibit as evidence** | ORIS-19; §7.6 — record events, derive interpretations |
| **User-curated AI memory UI** | **Do not pursue** | Outsources the architecture's hardest job to the user |

## 10.4 Sequencing, and the one thing to do first

The sequencing must respect the same rule as the cognitive programme: **substrate before
read-outs, measurement before adaptation.** Aligned with the epochs in `ORIS_ARCHITECTURE.md` §14:

**First — and this is the actual recommendation for the next action — measure the corpus.**
IH-1 and IH-10 are answerable *today*, against `AI_REFINEMENT.md`, the 50-prompt ledger, and the
routing ledger, with no new subsystem. They cost days, not quarters, and they determine whether
this document's central claims survive. **Designing the interaction architecture before running
that measurement would repeat the exact error the repo has a memory rule about** — trusting a
number before proving the instrument can tell the answers apart.

Thereafter, in dependency order and without dates:

1. **Interaction instrumentation (Epoch 0's interaction half).** Record witnessed interaction
   events per ORIS-18/19 — contributions offered, resolved, ignored, undone, with timing and
   boundary context. Zero behaviour change. This is the corpus every later hypothesis needs, and
   it is the interaction analogue of running fully instrumented and non-adaptive.
2. **Presence substrate (E).** σ made visible, honestly, within the body budget. Testable via
   IH-7 without any change to what ORIS *does*.
3. **Anchored proposals (D) with outcome capture.** The first surface that feeds the ledger. IH-2.
4. **Preparation (F).** Highest predicted value, and it requires no new interaction grammar —
   only availability. IH-5.
5. **The governor (G) as an extension of `act`'s codomain.** Only after 1–4 exist, because it
   arbitrates among them and has nothing to arbitrate before that. IH-3, IH-11.
6. **Batched critique (I), then chat/voice demotion.** Last, because demoting the current surface
   before the replacements are proven is how a working product gets worse.

## 10.5 What would falsify this recommendation

Recorded so the recommendation can fail, per house convention:

- **IH-10 comes back > 40 % prose-required.** Chat is more load-bearing than argued; Part 10 is
  substantially wrong and chat should be improved rather than demoted.
- **IH-7 fails.** Honest-state presence cannot produce partner-presence, meaning ORIS-2 caps how
  present ORIS can ever feel, and the substrate layer is decoration.
- **IH-5 fails.** Preparation goes unused, meaning ORIS cannot anticipate need well enough for the
  assistant-editor model, and the highest-value recommendation collapses.
- **IH-1 comes back < 15 %.** The grounding tax is small, Part 2's central claim is overstated,
  and the case for moving off chat weakens considerably.

## 10.6 The one-sentence form

> **ORIS should not be talked to. It should be present in the work, prepare ahead of need,
> propose in place, batch what is slow, speak only when the expectation gap justifies it — and
> keep prose and voice as the channels for the things only language can carry.**

That sentence is the hypothesis this document exists to test, not a conclusion it has earned.

---

## Appendix A — Where each brief question is answered

| Brief question | Section |
|---|---|
| What is fundamentally wrong with chat interfaces | §2.1–2.4, §2.7–2.9 |
| Why they never feel like talking to a human | §2.3, §3.1 (action ladder), §3.4 (presence) |
| Why voice mode still feels like voice chat | §2.6 |
| Which limitations are LLM / interaction / architecture | §2.5 (the attribution table) |
| Is "chat" the correct abstraction | §2.1, §5.1, §10.1 |
| Alternatives: collaboration / workspace / presence / attention | Part 5 (candidates D–I), §10.1 |
| How humans collaborate with editors, directors, partners | Part 3, §4.5 (the assistant editor) |
| Analysis of existing systems and their philosophies | §1.2–1.4 |
| Human conversation: turn-taking, repair, silence, reference | §3.1–3.3, §3.6 (what does not transfer) |
| Mixed-initiative and HCI literature | §2.7, §3.5, §5 Candidate G, §7.2 |
| Creative software interaction | Part 4 |
| ORIS implications: wait / interrupt / observe / ask / teach / challenge | §7.1–7.5 (especially §7.3's decision procedure) |
| How initiative should be balanced | §7.3, §7.4 (values give the ranking), IX-4 |
| Candidate models, evaluated without premature recommendation | Part 5 |
| Timeless principles | Part 6 (IX-1…IX-16) |
| Hypotheses requiring validation | Part 8 (IH-1…IH-12) |
| Open questions | Part 9 |
| Final recommendation | Part 10 |

## Appendix B — Claims this document makes that we believe are novel

Ranked by confidence that they are unsolved elsewhere, matching the convention in
`ORIS_ARCHITECTURE.md` §16.

1. **The band ladder determines the interaction surfaces** (§7.1). Interaction cadence is
   governed by the same period/reach physics as cognition, and chat's failure is precisely that it
   collapses seven bands into one.
2. **ORIS-13 applied to interaction forbids the industry's most popular memory feature** (§7.1.2).
   "The AI remembered what you said once" is a fast-band write to slow-band state, and it is why
   agent-memory products oscillate.
3. **Evidence yield as a first-class interaction-selection criterion** (§2.8, IX-6). A surface that
   emits no scoreable outcome starves a ledger-based organism, regardless of how good it feels.
4. **The mixed-initiative governor is `act` with a richer codomain, not a new subsystem** (§7.2).
   A worked rejection of a plausible new box, in the calculus's own idiom.
5. **The assistant-editor role as a pre-existing professional interaction contract for ORIS-1**
   (§4.5). Preparation, not proposal, is the highest-value collaborative act in editorial.
6. **Presence without affect is achievable and is what ORIS-2 forces** (§3.4, §7.5) — the
   constraint selects the better design rather than limiting it.
7. **Deterministic rendering makes proposals exactly previewable**, which raises the ceiling on
   proposal-mediated interaction beyond what any other creative tool can offer (§5 Candidate H;
   inherits `ORIS_ARCHITECTURE.md` §8).
8. **The attribution table** (§2.5): only ~1.5 of 13 salient chat failures are primarily
   model-caused. Simple to state, rarely stated, and it is the justification for the whole
   investigation.
