# ORIS — Gap Analysis

> **What this file is:** the synthesis that closes the research phase. It answers one question:
> *given everything the audits proved, what is still missing before the existing runtime satisfies
> ORIS's own architectural principles?*
>
> **What this file is not:** a new audit, an implementation plan, a redesign, or an essay. It
> derives nothing fresh from the code. Every claim is grounded in evidence already established by:
>
> | Source | Cited as |
> |---|---|
> | [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) | **[ARCH §n]** — the intended architecture |
> | [`ORIS_RESEARCH_PROGRAMME.md`](ORIS_RESEARCH_PROGRAMME.md) | **[PROG §n]** — stages, hypotheses, freeze |
> | [`ORIS_RUNTIME_STATE_AUDIT.md`](ORIS_RUNTIME_STATE_AUDIT.md) | **[RSA Part n]** — live-state forensics |
> | [`ORIS_IMPLICIT_CYCLE_AUDIT.md`](ORIS_IMPLICIT_CYCLE_AUDIT.md) | **[ICA Part n]** — cognitive-cycle forensics |
>
> Where an audit established a `file:line`, it is repeated so a conclusion can be checked without
> a second lookup. **No file was opened for this document.**
>
> **Status labels**, applied to architectural principles rather than to code:
>
> | Label | Meaning |
> |---|---|
> | **EXISTS** | The runtime satisfies the principle as stated. |
> | **PARTIAL** | Some of the principle is satisfied; the shortfall is named. |
> | **DISCONNECTED** | The component exists and functions, but is not in the loop the principle requires. A distinct failure from PARTIAL, and it recurs often enough to need its own label. |
> | **ABSENT** | No implementation exists. |
> | **UNKNOWN** | The audits could not settle it. What would settle it is named. |
>
> **Status:** v0, 2026-08-04. Synthesis document. **Nothing here is a proposal.**
> Appendix C is the only speculative section and contains no findings.

---

## 0. The synthesis in three sentences

**[Grounded: ICA Part 0, Part 8; RSA Part 7]**

1. **The runtime is further along than the architecture assumes, and further along in the wrong
   half.** A complete, resident, self-ticking cognitive cycle already exists — for the *body*
   [ICA Part 0, Loops G/H]. The mind's cycle exists too, and closes through five real learning
   loops [ICA Part 7, Loops A–E], but it is React-bound and never ticks unprompted.

2. **The three components ORIS names as its keystones are in three different states, and none is
   "not started."** The Experience Stream is built and **outside every loop** [ICA §7.1]; the
   Prediction Ledger is **declared and empty** (`ledger: []`, `stream.ts:81`) [ICA Part 9]; the
   self-model is **implicitly present** as a fact and its closure is **UNKNOWN** [ICA U1].

3. **The largest gap is not a missing component — it is that learning already happens outside the
   architecture that was designed to govern it.** Five shipped stores adapt behaviour today
   [ICA Loops A–E]; the programme's Epoch 0 precondition is "zero adaptation" [PROG §14]. That
   contradiction, not the absent subsystems, is what blocks the next stage (§7.1).

---

# PART 1 — Principle-by-principle status

Each row: the principle as stated in the architecture, its status, the evidence, what remains, and
whether the remainder is **architectural** (a design decision is missing), **implementation** (the
design exists, the code does not), or **integration** (both exist and are not connected).

## 1.1 The boundary and agency

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **ORIS-1 — acts freely on itself, never on the user's work** [ARCH §3.3, §18] | **EXISTS** | Registry-only mutation is shipped law; the commit choke point is the single seam and observation there may not alter semantics (`EditorPage.tsx:3252-3273`) [ICA Part 6] | — | — |
| **The Markov blanket / syscall line** [ARCH §3.3] | **EXISTS** | The choke point is the boundary; every mutation crosses it; background action is module-owned and gate-limited [ICA Part 6] | — | — |
| **Self/not-self boundary** [ARCH §1.2 item 6] | **PARTIAL** | The *action* boundary exists (above). The *authorship* boundary is declared, not witnessed: `initiator` is `null` unless a caller declares, and only the AI declares [RSA Part 6] | Human authorship is never witnessed at the seam | implementation |
| **Consequence · closed loop · finitude · boundary** (the four embodiment properties) [ARCH §3.1] | **EXISTS** | All four confirmed: irreversible commits; edits change what perception observes; frame/decode/heap budgets enforced by a real gate; the syscall line [ICA Parts 2, 3, 6] | — | — |

**[Confirmed] The architecture's strongest empirical claim survives.** [ARCH §3.1] asserts
*"Orreris has all four already, and unusually strongly"* and marks it **[NOVEL]**. The audits
confirm it without qualification — this is the single best-supported claim in the architecture.

## 1.2 Resident cognition and the cycle

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **The cycle must run when nobody is asking** [ARCH §3.4] | **PARTIAL — split** | **Body: EXISTS.** `setInterval(checkMemory)` (`degradation.ts:130`) has no `clearInterval`; `subscribeFrameStats(evaluate)` (`adaptive-quality.ts:146`) discards its unsubscribe. Both survive React teardown [ICA Part 0]. **Mind: ABSENT.** No timer/rAF/idle callback under `ai/**` except dictation's audio loop [ICA Part 0] | A reason for the *mind* to tick | architectural (the reason) + implementation (the tick) |
| **FAST / SLOW / SLEEP cadence** [ARCH §3.4] | **PARTIAL** | FAST exists (frame stats, ~16ms). SLOW partially exists as the perception scheduler's idle classes (`scheduler.ts:17-40`). SLEEP: ABSENT — no session-end or idle consolidation pass [ICA Part 9] | The SLOW cognitive tick and all of SLEEP | implementation |
| **"The existing perception scheduler and background gate are the seed"** [ARCH §3.4] | **CONFIRMED, and understated** | They are not a seed but a working closed loop with typed priorities, a shared authority, and a foreground/background rule keyed to whose intent is served [ICA Part 3, §3.1] | — | — |
| **Persistent situated cognition** [ARCH §1.1 item 4] | **PARTIAL** | Emerges for the body (stream + interoception + free-running cycle all present). For the mind, two of three are missing: no continuous cycle, no interoceptive input [ICA Parts 0, 8] | — | see rows above |

## 1.3 Embodiment and interoception

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **The render loop is the body; telemetry is interoception** [ARCH §3.2] | **EXISTS as signal** | Frame stats, decode pressure, heap, gate state, GPU tier — all present, most push-based and subscribable [RSA Part 1.2; ICA Part 2] | — | — |
| **The proto-self: a bounded body-state vector** [ARCH §4] | **ABSENT** | No such vector exists. Signals are spread across ~18 `__rf*` getters and 3 subscribable singletons with no aggregate [RSA §1.4] | The aggregation itself | implementation |
| **"Cognitive policy must be visibly modulated by body state"** [ARCH §3.2 — stated as the falsifiable consequence] | **ABSENT — and this is the sharpest gap** | No module under `apps/web/src/ai/**` imports `frame-stats`; the tier cascade consults neither the background gate nor the perception scheduler [ICA §8.1, K5]. The only bridge is body → perception scheduler, one-way [ICA Part 10] | The bridge from body state into planning effort | **integration** |
| **"Currently thrown away… telemetry read by humans in a HUD"** [ARCH §3.2] | **PARTIALLY DISPROVEN** | Not thrown away: one consumer already uses them (`whenBackgroundIdle` gates all idle/speculative perception, `scheduler.ts:38-40`) and two are subscribable [ICA Part 3] | — | — |

**[Confirmed] The falsification test is currently failing, and that is the correct reading.**
[ARCH §3.2] says *"a system that plans identically when starved and when idle is not situated."*
Per [ICA K5] the runtime plans identically. The architecture is not wrong; the runtime has not yet
met it, and the shortfall is **integration**, not construction — both endpoints exist.

## 1.4 Attention

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **Something must decide what is "now"** [ARCH §1.2 item 5] | **PARTIAL** | Three arbiters exist under other names: the background gate (resource), the perception scheduler (perceptual, 3 priorities, concurrency 1), the tier cascade (cognitive effort) [ICA Part 3] | No single "now" | architectural |
| **A bounded, serial workspace** [ARCH §11] | **ABSENT** | No workspace object exists. The perception scheduler has the serial property (concurrency 1) but holds jobs, not contents [ICA §3.1] | The workspace | implementation |
| **Global broadcast** [ARCH §11] | **ABSENT** | No broadcast bus. Cross-subsystem communication is point-to-point plus three subscribable singletons [RSA Part 3; ICA Part 11] | The bus | implementation |
| **Salience = urgency + error + learning progress + goal relevance − body cost** [ARCH §11] | **ABSENT** | Two of five terms have no source (error, learning progress — both require the ledger); body cost exists but does not reach cognition [ICA K5] | Depends on the ledger | implementation, gated |
| **Reject ECAN-style attention economies** [ARCH §11] | **SATISFIED BY DEFAULT** | Nothing of the kind was built [ICA Part 3] | — | — |

**[Confirmed] Attention already exists under another name — three times.** This is the audits'
answer to the architecture's *"something must decide what is now"* and it is a stronger starting
position than [ARCH §11] assumes. The gap is that the three do not share an authority: the tier
cascade is isolated from the other two [ICA §3.2].

## 1.5 Working memory and the core self

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **Core self — the workspace contents, persisted across ticks** [ARCH §4] | **ABSENT** | σ is unwired (`setSituation` has zero production call sites) and `PlannerContext` is rebuilt every iteration, never carried [RSA Part 1; ICA Part 4 W4] | Both the capture and the continuity | implementation |
| **"What is missing is continuity — today it is recomputed per query and forgotten"** [ARCH §4] | **CONFIRMED EXACTLY** | `buildContext` is a thunk re-invoked per iteration; the comment at `AiChatPanel.tsx:1440` reads *"Fresh timeline slice each iteration"* [ICA Part 4] | — | — |
| **Working memory observable by other subsystems** [ARCH §11 broadcast] | **ABSENT** | W1–W5 are React- or closure-owned; W3 (the authoritative reasoning accumulator) is a bare `const` [RSA Part 3; ICA Part 4] | — | implementation |
| **A fact belongs to exactly one decision** [ARCH §7; PROG §11.1] | **EXISTS as design, ABSENT as data** | The invariant is implemented and enforced (facts with no scope open are rejected, `stream.ts:695-712`) but `beginDecision`/`observeFact` have zero production call sites [ICA Part 4 W6] | The call sites | integration |

## 1.6 Memory: the Experience Stream

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **Episodic store — append-only, timestamped, surprise-weighted** [ARCH §5.1] | **PARTIAL** | Append-only ✓, timestamped ✓ (two clocks), ceiling ✓ (1500). **Surprise-weighted: ABSENT** — `tauInputs.surprise` is `null` by construction pending the ledger [ICA Part 12; PROG §12] | Surprise weighting | implementation, gated on the ledger |
| **"The single largest omission"** [ARCH §1.2 item 1] | **DISPROVEN AS FRAMED** — see §5.1 | The stream is built. What is missing is not a history substrate but a *consumer*: `listExperience`/`listDecisions`/`segment`/`experienceStats` have exactly two readers, both in the observatory panel [ICA §7.1] | A behavioural reader | **integration** |
| **ORIS-19 — record observations, never classifications** | **EXISTS** | Structurally enforced: no generic `append()`, one typed entry point per producer, episodes derived on read [ICA Part 2; RSA Part 1] | — | — |
| **ORIS-9 — every store has a ceiling** | **PARTIAL** | The stream declares one and reports eviction. The five learning stores mostly do not [ICA K3]; whether the phrase store has a ceiling is **UNKNOWN** [ICA U7] | Ceilings on R1–R5 | implementation |
| **ORIS-17 — no dangling references** | **EXISTS** | Implemented and enforced [ICA Part 2] | — | — |

## 1.7 Reflection and learning

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **Completed work influences future behaviour** [ARCH §5.3] | **EXISTS — five closed loops** | Rule trust → `isRuleTrusted` gating four routing sites; plan cache; phrase learning; memory facts → prompt; transcript → prompt [ICA Loops A–E] | — | — |
| **"Never let a single interaction modify slow structure"** [ARCH §5.2 prescription 1] | **PARTIAL** | Rule trust requires ≥2 explicit signals, is Laplace-smoothed, and recovers (`feedback.ts:73-77`) [ICA Part 7]. That is more than single-shot and less than *"many, interleaved with counter-examples"* | Interleaving | implementation |
| **"Consolidation must be offline and interleaved"** [ARCH §5.2 prescription 2] | **ABSENT** | No offline pass exists at any cadence [ICA Part 9] | Consolidation | implementation |
| **"The fast store must hold contradictions"** [ARCH §5.2 prescription 3] | **EXISTS** | The stream is append-only and resolves nothing at write time [ICA Part 2] | — | — |
| **Impasse-triggered learning (SOAR chunking)** [ARCH §5.3] | **PARTIAL** | Tier escalation *is* an impasse and is recorded (routing ledger). But `listRoutes` has zero consumers and `summarizeRouting` reaches a fact, not a decision [ICA §8.1] | The chunking step | implementation |
| **"The missing piece is letting bandit stats move the cascade boundary — per user"** [ARCH §5.4 item 1] | **DISPROVEN — already done** | `isRuleTrusted` gates `router.ts:164`, `router.ts:671`, `fast.ts:188`, `hypothesis-route.ts:228,242`; a distrusted rule escalates, per user, persisted [ICA Loop A] | — | — |
| **"Habits are currently global… should be context-bound"** [ARCH §5.4 item 2] | **CONFIRMED** | `isRuleTrusted(ruleId)` takes a rule id and no context [ICA Loop A] | Context guards | implementation |
| **ACT-R activation decay / forgetting** [ARCH §5.3, §13.2] | **ABSENT** | No decay function anywhere; the stream evicts by ceiling, not by activation [ICA Part 12] | — | implementation |
| **Storage proportional to surprise / residuals** [ARCH §13.2] | **ABSENT** | Requires surprise, which requires the ledger [ICA Part 9] | — | implementation, gated |

## 1.8 Prediction, metacognition, self-model

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **Prediction Ledger — "the keystone"** [ARCH §1.2 item 2, §7] | **ABSENT — declared, empty** | The producer exists in the type system with an empty kind list: `ledger: []` (`stream.ts:81`) [ICA Part 9]. The refs mechanism that will join prediction → outcome is already in place | The ledger | implementation |
| **ORIS-4 — every consequential act carries a prior claim** | **PARTIAL** | Claims are recorded on one path of three (`confidence` on the brain/plan path only) and are never scored [RSA Part 1; ORIS_OBSERVATORY §3.4 F2] | Scoring, and full claim coverage | implementation |
| **Calibration** [ARCH §7.2] | **ABSENT** | No claim/outcome pairing exists | — | implementation, gated |
| **Metacognition = Self Model × Prediction Ledger** [ARCH §1.1 item 6] | **ABSENT** | Both factors missing or partial | — | implementation, gated |
| **Structural self `S` (body schema)** [ARCH §4.1] | **PARTIAL** | Real components exist — `buildId`, `seatId`, coverage record, GPU/feature detection — but are not assembled into `S` [ICA Part 2; PROG §12.1] | The assembly | implementation |
| **Learned self-model (must be able to be surprised by itself)** [ARCH §4] | **PARTIAL / UNKNOWN** | An implicit self-model *is* produced: the user-profile observer builds `user.aiProfile` from rule stats + routing, with the summary as its own signature [ICA Loop F]. Whether any planner queries it is **UNKNOWN** [ICA U1] | Closure of Loop F | **UNKNOWN → then integration** |
| **Agent Model schema, instantiated twice** [ARCH §9.2] | **ABSENT** | No shared schema. What exists is one asymmetric artifact (a self-profile fact) and no user model at all | — | implementation |
| **Level-2 theory of mind / expectation gap** [ARCH §9.3] | **ABSENT** | No model of the user's model exists | — | implementation |

## 1.9 World model

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **World Model — semantic layer, current state** [ARCH §1.1 item 1] | **EXISTS** | Shipped: fact store, 10 registered observers, invalidation, confidence, query planning [ICA Part 2 P6] | — | — |
| **Pull-based perception, fidelity ladder** [ARCH §3.4 seed] | **EXISTS** | All observer work funnels through `schedulePerception` with typed priorities [ICA Part 3 A2] | — | — |
| **World Model supplies state both agent models condition on** [ARCH §9.1] | **BLOCKED** | The world model is ready; the agent models do not exist | — | see §1.8 |
| **Perception observable by other subsystems** | **ABSENT** | The fact store and observer registry have no subscription API — the only pure-pull source in the runtime [ICA §2.1] | A subscription | implementation |

## 1.10 Simulation

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **Deterministic ground-truth simulator** [ARCH §8.1, ranked #1 novel] | **EXISTS as capability, ABSENT as cognition** | The renderer is deterministic and the parity gates ship. Nothing in the cognitive path invokes it for rollout, counterfactual, or rehearsal [ICA Part 9] | The invocation | integration (pre-act rollout) / implementation (counterfactual, dreaming) |
| **Pre-act rollout feeding the ledger** [ARCH §8.2] | **ABSENT** | Requires the ledger | — | implementation, gated |
| **Counterfactual replay** [ARCH §8.2] | **ABSENT** | Requires stored past compositions joined to outcomes | — | implementation, gated |
| **ORIS-15 — promotion requires rehearsal** | **VACUOUSLY SATISFIED** | No promotions exist to require rehearsal of | — | — |

## 1.11 Valence, drives, values

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **Valence vector** [ARCH §6.1] | **ABSENT** | No such object [ICA Part 9] | — | implementation |
| **Neuromodulatory scalars (Θ)** [ARCH §6.2] | **ABSENT** | — | — | implementation |
| **Learning-progress drive** [ARCH §6.3] | **ABSENT** | Requires the ledger's error series | — | implementation, gated |
| **ORIS-3 — the anti-sycophancy setpoint** [ARCH §6.4] | **ABSENT** | No user-capability term exists anywhere | — | implementation |
| **Value hierarchy `V`** [ORIS_VALUES] | **ABSENT as runtime** | Exists as specification only; no error is typed or tiered at runtime [ICA Part 9] | — | implementation |
| **ORIS-2 — valence modulates, never performs** | **SATISFIED BY DEFAULT** | Nothing performs affect. The thinking display is causally downstream of real stream events (`AiThinkingLog.tsx:5-10`) [ORIS_OBSERVATORY §5 / ICA Part 5] | — | — |

## 1.12 Identity, governance, development

| Principle | Status | Evidence | What remains | Class |
|---|---|---|---|---|
| **Plasticity gradient / identity stratum** [ARCH §10.2] | **ABSENT** | No learning rate is attached to anything; the five learning stores have flat, ungraded update rules [ICA Loops A–E] | — | implementation |
| **ORIS-13 — no operator writes to a slower band** | **PARTIAL / AT RISK** | Rule trust is written from single-turn feedback into a persistent cross-session store with no decay [ICA Loop A, K3]. Mitigated by the ≥2-signal gate and reversibility (`feedback.ts:73-77`); **not** mitigated by interleaving or by a band boundary. See §5.2 | Band discipline over R1–R5 | **architectural** |
| **ORIS-8 — every learned parameter carries its justifying episodes** | **ABSENT** | The five learning stores keep counters and payloads, not evidence chains [ICA K3] | — | implementation |
| **ORIS-7 — divergence is data, never code** | **EXISTS in practice** | All divergence lives in localStorage; no code path differs per install [ICA Part 12] | A single portable psyche volume (currently 6 keys) | implementation |
| **Governance lifecycle: shadow → probation → adopt → revoke** [ARCH §12.2] | **ABSENT** | No staged lifecycle. R1–R5 adopt immediately on write [ICA Loops A–E] | — | implementation |
| **"The eval harness is the immune system"** [ARCH §12.1, ranked #4 novel] | **EXISTS — patient absent** | `brain:eval`, `world:eval`, pixel gates, `experience:eval` with a shrinkage guard and a typecheck ratchet all ship [PROG §11.3] | Something to govern | — |
| **Epochs, self-gated on calibration** [ARCH §14] | **BLOCKED** | Epoch 0 requires zero adaptation; five loops adapt [ICA Loops A–E]. See §7.1 | Resolution of the contradiction | **architectural** |

---

# PART 2 — Principles already satisfied

**[Grounded: Part 1]** Ten, and they are not trivial ones.

1. **ORIS-1** — organism acts on itself, never on the user's work.
2. **The Markov blanket** — one syscall line, structurally enforced.
3. **All four embodiment properties** [ARCH §3.1] — the architecture's flagship [NOVEL] claim.
4. **A free-running cycle exists** — for the body, and it cannot be stopped.
5. **The World Model** — shipped, with pull-based perception and a fidelity ladder.
6. **Reflection is real** — five closed loops that change behaviour.
7. **The cascade boundary already moves per user** — [ARCH §5.4 item 1]'s "missing piece" is not missing.
8. **ORIS-19 / ORIS-17 / ORIS-18** — the corpus integrity model, structurally enforced.
9. **ORIS-2** — no theater anywhere; the one thinking display is causally honest.
10. **The eval harness** — the immune system, complete and guarded against its own failure modes.

---

# PART 3 — Principles partially satisfied

**[Grounded: Part 1]**

| Principle | Satisfied part | Shortfall |
|---|---|---|
| Cognitive cycle | Body ticks unprompted | Mind never ticks |
| Attention | Three working arbiters | No shared authority, no workspace, no broadcast |
| Episodic memory | Append-only, ceilinged, two clocks | No surprise weighting, no decay |
| Slow-structure protection | ≥2 signals, smoothed, reversible | No interleaving, no offline pass |
| Impasse learning | Impasses recorded | Nothing consumes the record |
| Structural self `S` | Components exist | Never assembled |
| ORIS-4 | Claims recorded on one path | Never scored; coverage incomplete |
| ORIS-9 | Stream has a ceiling | Learning stores mostly do not |
| ORIS-13 | ≥2-signal gate | No band boundary over R1–R5 |
| Self/not-self | Action boundary exact | Authorship declared, not witnessed |

---

# PART 4 — Principles that exist but are disconnected

**[Grounded: ICA §7.1, §8.1, K5; RSA Part 3]** This is the category the audits made visible and it
is the most actionable, because **both endpoints already exist in every row.**

| # | Component | Exists | Disconnected from | Evidence |
|---|---|---|---|---|
| **D1** | Experience Stream | fully built, integrity-enforced | **every behavioural consumer** — 2 readers, both in the observatory panel | ICA §7.1 |
| **D2** | Interoception | subscribable, push-based | **cognition** — no `frame-stats` import under `ai/**`; cascade consults no gate | ICA K5, §8.1 |
| **D3** | Routing ledger | recorded per request | **routing** — `listRoutes` has zero consumers | ICA §8.1 |
| **D4** | Deterministic renderer | exact, parity-gated | **planning** — never invoked for rollout | ICA Part 9 |
| **D5** | Live cognitive state | computed at 11 transitions | **every other subsystem** — terminates in `setState` | RSA §0.1 |
| **D6** | Pending edit (`plan`) | structured, human-scale lifetime | **anything outside React** | RSA Part 6 |
| **D7** | Fact-scope machinery | invariant implemented and enforced | **the runtime** — zero production call sites | ICA Part 4 W6 |
| **D8** | Self-profile fact (Loop F) | produced, auto-invalidating | **UNKNOWN** whether any planner queries it | ICA U1 |

**[Synthesis]** Seven of eight are **integration** gaps, not implementation gaps. D8 is UNKNOWN and
must be resolved before it can be classified.

---

# PART 5 — Assumptions disproven by the audits

Five. Each is a claim in the intended architecture that the runtime evidence contradicts. None
invalidates the architecture; each changes what remains to be done.

## 5.1 "The Experience Stream is the single largest omission" [ARCH §1.2 item 1]

**DISPROVEN AS FRAMED.** The stream is built, integrity-enforced, and persisted. The reasoning
behind the claim — *"nothing in the ten models can exist without a history substrate underneath
it"* — is contradicted by the runtime: **five learning loops exist and change behaviour with no
history substrate at all** [ICA Loops A–E]. Learning did not wait for episodic memory; it grew
five ad-hoc stores instead.

**Consequence:** the omission is not the substrate but the *consumer*. The gap is integration, and
the harder question it exposes is §7.1.

## 5.2 "Never let a single interaction modify slow structure" — assumed not yet at risk [ARCH §5.2]

**PARTIALLY DISPROVEN.** The architecture states this as a prescription for future work. The
runtime already writes single-turn feedback into a persistent cross-session store that shapes
routing [ICA Loop A]. It is **not** a naive violation — the ≥2-signal Laplace gate and reversibility
(`feedback.ts:73-77`) are real mitigations, and they are better than most agent-memory products
[ORIS_INTERACTION §7.1.2]. But there is no interleaving, no offline pass, and no band boundary.

**Consequence:** ORIS-13 compliance is a live question about shipped code, not a future design rule.

## 5.3 "The missing piece is letting bandit stats move the cascade boundary" [ARCH §5.4 item 1]

**DISPROVEN — already implemented.** `isRuleTrusted` gates four routing sites and a distrusted rule
escalates, per user, persisted [ICA Loop A].

**Consequence:** one named gap closes. [ARCH §5.4 item 2] (context-bound habits) remains open and
is confirmed.

## 5.4 "DecisionTrace already records intent → route → facts → operations → outcome… O1 is close to free" [ARCH §19]

**PARTIALLY DISPROVEN.** It records intent, route, and operations. It does **not** record facts
(zero call sites), situation (zero call sites), or candidates (never emitted); confidence lands on
one path of three and `startedAt` on two of three [RSA Part 1; ORIS_OBSERVATORY §3.4]. Outcome was
already known to be absent [PROG §12.1 Finding 0]. The capture seam also **never fires for
tier-0/1 turns**, which return before the trace call [RSA §2.1].

**Consequence:** O1 was cheaper than a green field and more expensive than "close to free."

## 5.5 Interoceptive signals are "currently thrown away" [ARCH §3.2]

**PARTIALLY DISPROVEN.** They are subscribable, and one consumer already uses them — every idle and
speculative observation awaits `whenBackgroundIdle()` [ICA Part 3].

**Consequence:** the body→mind bridge is not absent, it is *narrow*: it reaches the perception
scheduler and stops before the tier cascade [ICA Part 10].

---

# PART 6 — Assumptions strongly confirmed

Six, each load-bearing.

1. **All four embodiment properties are present, unusually strongly** [ARCH §3.1] — the flagship
   [NOVEL] claim, confirmed without qualification [ICA Parts 2, 3, 6].
2. **A free-running cycle is what makes a system situated** [ARCH §3.4] — confirmed by contrast:
   the body has one and is situated; the mind lacks one and is not [ICA Part 0].
3. **The core self is missing precisely because context is recomputed and forgotten** [ARCH §4] —
   confirmed to the word; `buildContext` is re-invoked per iteration [ICA Part 4].
4. **Habits are global and should be context-bound** [ARCH §5.4 item 2] — confirmed;
   `isRuleTrusted(ruleId)` takes no context [ICA Loop A].
5. **The eval harness is a genuine differentiator** [ARCH §12.1] — confirmed; it ships, guards
   itself against silent success, and has already caught two real defects [PROG §11.3].
6. **The deterministic renderer is a ground-truth simulator no other architecture has**
   [ARCH §8.1] — confirmed as capability [ICA Part 9]. It is simply not wired to cognition.

---

# PART 7 — Unknowns that remain before implementation should begin

Ranked by whether they block. Sources: [ICA U1–U7], [RSA U1–U6], [PROG §20].

## 7.1 Blocking

**B1 · Are the five shipped learning loops inside or outside the programme's governance?**
[PROG §14] defines Epoch 0 as *"Records only… zero adaptation"* and [PROG §10] forbids adaptation
above band B2 for the entire programme. Five loops adapt today [ICA Loops A–E], at least one of
them into cross-session persistent structure [ICA Loop A].
**This is the single blocking question.** Until it is answered, Epoch 0 cannot be entered honestly,
because its precondition is already false. It is **architectural**, not technical: the answer is a
ruling about scope, not a piece of code.

**B2 · Does Loop F close?** [ICA U1] The self-profile fact is produced; no consuming query was
traced. If it closes, an implicit self-model already influences behaviour and §1.8's status changes
from ABSENT to DISCONNECTED-or-EXISTS. *Settles by:* tracing `USER_AI_PROFILE_FACT` consumers.

**B3 · Is the signal dense enough?** [PROG §20 Q1] Unchanged by the audits and still the
programme's own falsification gate. *Settles by:* [RSA U3] / [ICA U4] — the tier distribution over
the existing corpus, answerable with no code.

## 7.2 Non-blocking but shapes scope

| # | Unknown | Source | Settles by |
|---|---|---|---|
| N1 | Does `t2.plan-cache` distrust disable the cache globally per user? | ICA U2, K2 | reading the trust gate against cache key granularity |
| N2 | Do direct editor gestures have any pre-commit intent representation? | RSA U2 | running the existing `?orisWriteProbe=1` instrument |
| N3 | Does `AiChatPanel` unmount in normal use? | RSA U4, ICA U3 | observation |
| N4 | Is `speculative` priority ever used in production? | ICA U5 | enumerating `schedulePerception` call sites |
| N5 | Does the phrase store have a ceiling? | ICA U7 | reading `learnPhrase` |
| N6 | Cost of subscription fan-out under load | RSA U6 | measurement |
| N7 | Episode boundary correctness | PROG §20 Q2 | Stage C — unchanged |
| N8 | Where the LLM belongs in consolidation | PROG §20 Q5 | unchanged |

**[Synthesis]** The audits *reduced* the unknown set rather than expanding it. Every remaining
blocking unknown is answerable with existing instruments and no new code.

---

# PART 8 — Dependency graph

**[Grounded: Part 1 status column.]** Read as: a capability cannot be satisfied until everything
below it is. `✓` = the dependency is already satisfied.

```
GOVERNANCE (shadow → probation → adopt → revoke)
  └── plasticity gradient
        └── consolidation (offline, interleaved)
              └── Experience Stream ✓ EXISTS
              └── a behavioural READER of it        ◄── D1 · integration
              └── SLEEP cadence                     ◄── absent
              └── surprise weighting
                    └── PREDICTION LEDGER

IDENTITY (commitments, refusals, character sheet)
  └── consolidation (above)
  └── ORIS-15 rehearsal
        └── SIMULATION
              └── deterministic renderer ✓ EXISTS
              └── invocation from planning          ◄── D4 · integration
              └── user model (the dynamics model)
                    └── Agent Model schema
                          └── PREDICTION LEDGER

METACOGNITION / CALIBRATION
  └── PREDICTION LEDGER                             ◄── THE KEYSTONE
        ├── Experience Stream ✓ EXISTS
        ├── claim capture (confidence, candidates)  ◄── partial: 1 of 3 paths
        ├── ACTION OUTCOMES                         ◄── absent by design (ORIS-19:
        │     └── editor action rows ✓ EXISTS             outcomes are DERIVED, and
        │     └── a read-time derivation policy           the derivation has no author)
        └── refs join mechanism ✓ EXISTS

CONTINUOUS COGNITION (the mind ticks unprompted)
  ├── resident runtime (module-owned, not React)    ◄── D5 · integration
  ├── attention (a shared authority)                ◄── 3 arbiters exist, unshared
  │     ├── background gate ✓ EXISTS
  │     ├── perception scheduler ✓ EXISTS
  │     └── tier cascade ✓ EXISTS (isolated)
  ├── scheduling ✓ EXISTS (whenBackgroundIdle)
  └── A REASON TO TICK                              ◄── architectural, and the
        └── drives                                        deepest single gap
              └── learning progress
                    └── PREDICTION LEDGER

SITUATEDNESS (mind)
  ├── core self (σ persisted across ticks)          ◄── setSituation unwired
  ├── continuous cycle (above)
  └── interoception → cognition                     ◄── D2 · integration
        ├── body signals ✓ EXISTS (subscribable)
        └── proto-self vector (aggregation)         ◄── implementation

VALENCE / DRIVES
  ├── interoception ✓ EXISTS as signal
  ├── proto-self vector                             ◄── implementation
  └── outcome error
        └── PREDICTION LEDGER

WORLD MODEL ✓ EXISTS — no unmet dependencies
EMBODIMENT ✓ EXISTS — no unmet dependencies
ORIS-1 / BLANKET ✓ EXISTS — no unmet dependencies
EVAL HARNESS ✓ EXISTS — awaiting a patient
REFLECTION (five loops) ✓ EXISTS — but ungoverned (B1)
```

## 8.1 What the graph shows

**[Synthesis]** Three results.

1. **The Prediction Ledger is a dependency of five of seven top-level capabilities.** The
   architecture calls it *"the keystone"* [ARCH §1.2 item 2]; the dependency structure confirms it
   is load-bearing in the strict sense — remove it and metacognition, consolidation, identity,
   simulation, and drives all lose their base.
2. **The ledger's own blocker is not the ledger.** It needs *action outcomes*, and ORIS-19 rules
   that outcomes are **derived, never recorded** [ICA Part 2]. The raw material exists (editor
   action rows: commit/undo/redo with `graphVersion` and `undoDepth`). What is missing is a named
   derivation policy — which is **architectural**, not implementation, and is exactly what ORIS-20
   demands of any derived value.
3. **"A reason to tick" is the deepest gap and the only one with no shorter path.** Every other
   branch bottoms out in either an existing component or the ledger. The mind's tick bottoms out in
   drives → learning progress → the ledger, and [ARCH §3.4] already names it: *"What is missing is
   a reason to tick when there is no query."* The audits confirm nothing has changed.

---

# PART 9 — Implementation readiness assessment

## 9.1 The level

> ### **Level 3 — Runtime exists but fragmented.**

## 9.2 Why not lower

**Not Level 0 (research incomplete).** The research phase produced a frozen architecture, a formal
calculus with an admission test, four companion specifications, a staged empirical programme with
pre-registered hypotheses and kill criteria, and two forensic audits. The remaining unknowns
(§7) are three, all answerable with existing instruments.

**Not Level 1 (architecture incomplete).** Physics is frozen, biology near-frozen, and [PROG §1]
provides the rejection procedure for new components. Two reviews have pushed against the
seven-variable reduction and both were absorbed [ARCH Appendix C].

**Not Level 2 (architecture complete but runtime missing).** The runtime is substantially present:
the World Model ships, the Experience Stream ships with its integrity model enforced, three
attention arbiters work, a free-running body cycle runs and cannot be stopped, five learning loops
close, and the eval harness ships with its own self-verification. Ten principles are **satisfied
outright** (Part 2).

## 9.3 Why not higher

**Not Level 4 (integration phase).** Level 4 presupposes that the parts exist and need connecting.
Eight do (Part 4, D1–D8) — but the dependency graph shows five top-level capabilities blocked on a
component that **does not exist in any form**: the Prediction Ledger is a declared producer with an
empty kind list. Consolidation, simulation, valence, drives, and the plasticity gradient are
likewise ABSENT, not disconnected. Calling this integration would misdescribe roughly half the
remaining work as wiring.

**Not Level 5.** Blocking unknown B1 is unresolved, and it is architectural.

## 9.4 The qualification that matters more than the number

**[Synthesis]** A single level hides that the system is at **three different levels along three
tracks**, and the tracks do not advance together:

| Track | Level | Justification |
|---|---|---|
| **Observability spine** — stream, world model, eval harness, integrity model | **Level 4 — integration** | Built and correct; needs consumers (D1, D7) |
| **Body / situatedness** — interoception, attention, scheduling, free-running cycle | **Level 4 — integration** | All endpoints exist; the bridge is narrow (D2) |
| **Developmental machinery** — ledger, consolidation, simulation, valence, identity, governance | **Level 2 — runtime missing** | Architecture complete, implementation absent |

**Level 3 is the honest aggregate** precisely because these three coexist: fragments at different
maturities, not a uniform stage.

## 9.5 What separates Level 3 from Level 4

Three things, and only one is technical:

1. **[architectural] Resolve B1** — are the five shipped learning loops inside the programme?
   Epoch 0's precondition is currently false.
2. **[architectural] Name the outcome derivation policy** — ORIS-19 forbids recording outcomes;
   the ledger needs them; the raw material exists. This is a policy decision (ORIS-20), not code.
3. **[investigation] Resolve B2** — does Loop F close? One traced query settles whether an implicit
   self-model already influences behaviour.

None requires new architecture. None requires an implementation decision. **All three are rulings
or lookups**, which is itself evidence that the research phase has done its job.

---

## Appendix A — Status summary

| Category | Count | Members |
|---|---|---|
| **EXISTS** | 10 | ORIS-1 · blanket · embodiment ×4 · body cycle · world model · reflection loops · cascade boundary moves · corpus integrity (17/18/19) · ORIS-2 · eval harness |
| **PARTIAL** | 10 | cognitive cycle · attention · episodic memory · slow-structure protection · impasse learning · `S` · ORIS-4 · ORIS-9 · ORIS-13 · self/not-self |
| **DISCONNECTED** | 8 | D1 stream · D2 interoception · D3 routing ledger · D4 renderer · D5 live state · D6 pending edit · D7 fact scope · D8 self-profile (UNKNOWN) |
| **ABSENT** | 14 | Prediction Ledger · consolidation · forgetting/decay · simulation (as cognition) · valence · drives · `V` at runtime · Agent Model schema · user model · level-2 ToM · plasticity gradient · governance lifecycle · workspace · broadcast |
| **UNKNOWN** | 3 blocking + 8 non-blocking | §7 |

## Appendix B — Gap class tally

**[Synthesis]** Of the gaps that are not UNKNOWN:

| Class | Count | Meaning |
|---|---|---|
| **Integration** | 8 | both endpoints exist; nothing connects them |
| **Implementation** | 14 | the design exists; the code does not |
| **Architectural** | 3 | a ruling is missing — B1, the outcome derivation policy, and a single attention authority |

The architectural count being 3 — and all three being rulings rather than designs — is the
strongest single indicator supporting Level 3 rather than Level 1 or 2.

## Appendix C — Speculative

**Contains no findings. Isolated per the evidence rules and asserted by nothing above.**

- Whether the five ad-hoc learning stores would be better subsumed by the Experience Stream, or
  better left alone and merely governed, is not determinable from the audits.
- Whether "a reason to tick" can be supplied before drives exist is unresolved by the dependency
  graph, which shows only that the architecture's own route runs through them.
- Whether the three attention arbiters *should* share an authority, or whether their independence
  is correct for a system whose body and mind run at different cadences, is a design question the
  audits do not settle.
- No claim is made here about sequencing, cost, or priority. Those are not research outputs.
