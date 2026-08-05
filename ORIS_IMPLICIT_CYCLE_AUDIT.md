# ORIS — Implicit Cognitive Cycle Audit

> **What this file is:** a forensic determination of whether the shipped runtime already contains
> a cognitive cycle, searched by *function* rather than by name. Names like "planner", "brain",
> and "executor" were ignored; the search was for perception, attention, working memory,
> deliberation, action, reflection, and closure.
>
> **What this file is not:** implementation, redesign, or proposal. Nothing is invented. Part 15
> is the only speculative section and contains no findings.
>
> **Evidence discipline**, identical to [`ORIS_RUNTIME_STATE_AUDIT.md`](ORIS_RUNTIME_STATE_AUDIT.md):
>
> | Label | Meaning |
> |---|---|
> | **[EXISTS]** | Read from code on this branch. `file:line` given. Verifiable by opening it. |
> | **[INFERRED]** | Follows from read code but was not observed running. The inference step is stated. |
> | **[UNKNOWN]** | Not determinable statically. Says what would settle it. |
> | **[SPECULATIVE]** | Quarantined in Part 15. Never mixed into a finding. |
>
> **Branch:** `method-3-gpu-compositor`, audited 2026-08-04.

---

## 0. The answer to the Most Important Question

> *"If every UI disappeared tomorrow, would cognition still continue to exist as a runtime
> process, or would the organism disappear with React?"*

**[EXISTS] Neither. There are two cycles, and they answer oppositely.**

```
┌────────────────────────────────────────────────────────────────────────────┐
│ THE BODY CYCLE     survives React teardown, and TICKS ON ITS OWN            │
│                    module singletons · subscribe-based · permanent once     │
│                    started · no unsubscribe is ever called                  │
├────────────────────────────────────────────────────────────────────────────┤
│ THE MIND CYCLE     dies with the component — and even while React is alive, │
│                    it NEVER TICKS UNPROMPTED. Every rotation is driven by a │
│                    user submit. Its only persistence is localStorage.       │
└────────────────────────────────────────────────────────────────────────────┘
```

**[EXISTS] The body ticks without anyone asking, and cannot be stopped.**
`window.setInterval(checkMemory, MEM_CHECK_INTERVAL_MS)` at
[degradation.ts:130](apps/web/src/editor/performance/degradation.ts#L130) is never cleared —
there is **no `clearInterval` and no `disconnect` anywhere in that file**. Its sibling,
`subscribeFrameStats(evaluate)` at
[adaptive-quality.ts:146](apps/web/src/editor/performance/adaptive-quality.ts#L146), **discards
the returned unsubscribe function**. Both are guarded by an idempotent `started` flag
([degradation.ts:122](apps/web/src/editor/performance/degradation.ts#L122),
[adaptive-quality.ts:142](apps/web/src/editor/performance/adaptive-quality.ts#L142)) and are
kicked once from React ([EditorPage.tsx:1772](apps/web/src/pages/EditorPage.tsx#L1772),
[VideoPreview.tsx:828](apps/web/src/components/VideoPreview.tsx#L828)).

> **[INFERRED]** React *starts* the body cycle and cannot *stop* it. Unmounting every component
> leaves the memory-pressure loop running on its interval, still writing
> `setBackgroundGate("memory", …)` ([degradation.ts:108,116](apps/web/src/editor/performance/degradation.ts#L108))
> into a module singleton that other subsystems can still read and subscribe to.
> *Inference step:* teardown was not executed; the conclusion follows from the absence of any
> cleanup path in files that were read in full.

**[EXISTS] The mind has no tick at all.** Every rotation of the cognitive cycle begins at
`handleSubmit` in [AiChatPanel.tsx](apps/web/src/components/ai/AiChatPanel.tsx) and ends at
`setPhase("idle")`. Searching `apps/web/src/ai/**` for `setInterval`, `requestAnimationFrame`,
and `requestIdleCallback` returns **exactly two hits, both in `useDictation.ts`**
([:239,:241](apps/web/src/ai/useDictation.ts#L239)) — an audio-level rAF loop inside a React
hook, not cognition. There is no free-running cognitive loop in the AI subsystem.

> **The precise answer:** the organism does not disappear with React — but what survives is the
> body, not the mind. Against LIDA's criterion, quoted in
> [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) §3.4 (*"an assistant is a function invoked by a
> prompt; a resident is a loop that ticks regardless"*), **the body is already a resident and the
> mind is still an assistant.**

---

# PART 1 — Cognitive cycle map

**[EXISTS] All six functional stages exist in the runtime.** They are not named as such and are
not assembled into one loop, but each is implemented.

| Stage | Exists? | Implementation | Owner class |
|---|---|---|---|
| **Perception** | **✓** | 9 distinct sources (Part 2) | mixed |
| **Attention** | **✓** | 3 independent arbiters under other names (Part 3) | module |
| **Working memory** | **✓** | 6 transient stores (Part 4) | React/closure |
| **Deliberation** | **✓** | 5-tier cascade + agent loop (Part 5) | React-driven |
| **Action** | **✓** | registry → commit choke point (Part 6) | React/module |
| **Reflection** | **✓** | 5 closed learning loops (Part 7) | module + localStorage |
| **Closure** | **✓ partial** | 8 loops found; 1 major substrate outside all of them (Part 8) | — |

---

# PART 2 — Perception

**[EXISTS]** Nine sources through which information enters. `Push?` = notifies without being
asked. `Survives?` = outlives React teardown. `Sub?` = another subsystem can subscribe.

| # | Source | Owner | Push/Pull | Survives? | Sub? | Reference |
|---|---|---|---|---|---|---|
| P1 | Background gate conditions | module singleton | **push** | **✓** | **✓** | [backgroundScheduler.ts:34-55](apps/web/src/editor/performance/backgroundScheduler.ts#L34-L55) |
| P2 | Frame statistics | module singleton | **push** (throttled 500ms) | **✓** | **✓** | [frame-stats.ts:150-187](apps/web/src/editor/performance/frame-stats.ts#L150-L187) |
| P3 | Long-task + heap pressure | module singleton | **push** (interval + PerfObserver) | **✓** | ✓ via P1 | [degradation.ts:125-130](apps/web/src/editor/performance/degradation.ts#L125-L130) |
| P4 | Experience Stream appends | module singleton | **push** | **✓** | **✓** | [stream.ts:870](apps/web/src/ai/experience/stream.ts#L870) |
| P5 | Editor commits (timeline change) | choke point → P4 | push | ✓ (as rows) | ✓ via P4 | [EditorPage.tsx:3255-3273](apps/web/src/pages/EditorPage.tsx#L3255-L3273) |
| P6 | World observers (metadata, look, faces, scene, format, character, system, user, project-media) | registry | **pull only** | **✓** | ✗ | [world/index.ts:25-39](apps/web/src/ai/world/index.ts#L25-L39), [observers.ts:2-5](apps/web/src/ai/world/observers.ts#L2-L5) |
| P7 | User messages | React `useState` | push → callback | **✗** | ✗ | [AiChatPanel.tsx:228](apps/web/src/components/ai/AiChatPanel.tsx#L228) |
| P8 | Playback state | React `useState` + ref | push → P1 only | **✗** (mirrored) | ✓ via P1 | [EditorPage.tsx:953,1999](apps/web/src/pages/EditorPage.tsx#L953) |
| P9 | Pointer gesture start/end | DOM listeners → P1 | push → P1 only | ✗ | ✓ via P1 | [EditorPage.tsx:2006-2017](apps/web/src/pages/EditorPage.tsx#L2006-L2017) |

## 2.1 Findings

**[EXISTS] Perception is majority push and majority survives teardown.** Five of nine sources
(P1–P5) are module-owned, push-based, and subscribable by another subsystem today.

**[EXISTS] The World Model — the subsystem explicitly *about* knowledge — is the only pure-pull
source.** The observer registry's docstring describes declared economics chosen by a query
planner ([observers.ts:2-10](apps/web/src/ai/world/observers.ts#L2-L10)), and all observer work
funnels through `schedulePerception` ([scheduler.ts:31](apps/web/src/ai/world/scheduler.ts#L31)).
There is no subscription API on the fact store or the observer registry.

**[INFERRED]** P8 and P9 are *lossy* as perception: playback and gesture are visible to other
subsystems only as an opaque gate reason, not as themselves. A consumer can learn *that*
background work is blocked and *that* the reason is `"playing"`, but not the playhead position or
the gesture target. *Inference step:* read from the gate's 5-value string union at
[backgroundScheduler.ts:21](apps/web/src/editor/performance/backgroundScheduler.ts#L21); no
richer channel was found, but absence of a channel is harder to prove than presence.

---

# PART 3 — Attention

**[EXISTS] Attention exists, three times, under three other names, with no shared authority.**

| Mechanism | What it arbitrates | Priority model | Reference |
|---|---|---|---|
| **A1 · Background gate** | *may deferrable work run at all* | binary, 5 typed reasons, any-blocks | [backgroundScheduler.ts:21-48](apps/web/src/editor/performance/backgroundScheduler.ts#L21-L48) |
| **A2 · Perception scheduler** | *which observation runs next* | 3-level ordered queue, **concurrency 1**, FIFO within class | [scheduler.ts:17-71](apps/web/src/ai/world/scheduler.ts#L17-L71) |
| **A3 · Tier cascade** | *how much thinking a request deserves* | 5 tiers, precision-first, escalate-on-decline | [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md); router at [router.ts:164,671](apps/web/src/ai/brain/router.ts#L164) |

## 3.1 The strongest evidence that A2 is attention rather than scheduling

**[EXISTS]** `PerceptionPriority = "user-blocking" | "idle" | "speculative"`
([scheduler.ts:17](apps/web/src/ai/world/scheduler.ts#L17)), and the docstring states the
arbitration rule explicitly: *"`user-blocking` (the user asked a question and is waiting) runs
even while the background gate is closed — it's the user's own foreground intent, same as
scrubbing"* ([scheduler.ts:7-9](apps/web/src/ai/world/scheduler.ts#L7-L9)). Non-blocking
priorities `await whenBackgroundIdle()` before running
([scheduler.ts:38-40](apps/web/src/ai/world/scheduler.ts#L38-L40)).

**[INFERRED]** That is a foreground/background distinction governed by whose intent is being
served, with a serial bottleneck (`concurrency 1`, [scheduler.ts:5](apps/web/src/ai/world/scheduler.ts#L5))
— functionally an attention mechanism, not a thread pool. *Inference step:* the mapping to
attention is an interpretation of read code, not a claim the authors intended it.

## 3.2 Other filtering found

**[EXISTS]**
- **Coalescing/debounce:** `PERSIST_DEBOUNCE_MS = 750` ([stream.ts:408](apps/web/src/ai/experience/stream.ts#L408));
  `NOTIFY_INTERVAL_MS = 500` throttles frame-stats subscriber notification
  ([frame-stats.ts:17](apps/web/src/editor/performance/frame-stats.ts#L17));
  `IDLE_DEBOUNCE_MS = 600` prevents deferred work landing on the first beat after a pause
  ([backgroundScheduler.ts:27](apps/web/src/editor/performance/backgroundScheduler.ts#L27)).
- **Suppression:** a distrusted rule stops firing —
  `return isRuleTrusted(ruleId) ? result : ESCALATE`
  ([router.ts:164](apps/web/src/ai/brain/router.ts#L164)).
- **Budgets:** iteration caps ([AgentLoop.ts:24](apps/web/src/ai/agent/AgentLoop.ts#L24)),
  event ceiling `MAX_EVENTS = 1500` ([stream.ts:410](apps/web/src/ai/experience/stream.ts#L410)),
  reasoning cap `REASONING_CAP = 3000` ([openai-stream.ts:18](apps/web/src/ai/openai-stream.ts#L18)),
  WebCodecs session cap ([preview-frame-pool.ts:10-12](apps/web/src/playback/preview-frame-pool.ts#L10-L12)).
- **Resource pre-emption:** proxy generation is aborted when playback starts
  ([EditorPage.tsx:2605,2613,2621,2637](apps/web/src/pages/EditorPage.tsx#L2605)).

**[EXISTS] A1 is a shared authority; A2 and A3 are not.** The gate exists so producers *"don't
subscribe to each condition separately"* ([backgroundScheduler.ts:6-8](apps/web/src/editor/performance/backgroundScheduler.ts#L6-L8)),
and A2 explicitly reuses it rather than growing a second suspension system
([scheduler.ts:9-11](apps/web/src/ai/world/scheduler.ts#L9-L11)). **A3 does not consult A1 or A2
at all** — no import of `backgroundScheduler` or `schedulePerception` appears in
[router.ts](apps/web/src/ai/brain/router.ts).

---

# PART 4 — Working memory

**[EXISTS]** Six transient stores. None is observable outside its owner.

| # | Store | Contents | Lifetime | Owner | Observable? | Reference |
|---|---|---|---|---|---|---|
| W1 | `plan` | the pending edit (`AiPlan`) | human-scale (until approve/cancel) | React `useState` | **✗** | [AiChatPanel.tsx:229](apps/web/src/components/ai/AiChatPanel.tsx#L229) |
| W2 | `think` | phase index + reasoning + provider | one planning run | React `useState` | **✗** | [AiChatPanel.tsx:265](apps/web/src/components/ai/AiChatPanel.tsx#L265) |
| W3 | `live` | authoritative reasoning accumulator | one run | **bare closure `const`** | **✗** | [AiChatPanel.tsx:1744](apps/web/src/components/ai/AiChatPanel.tsx#L1744) |
| W4 | `PlannerContext` | composition + selection + history + memory + continuity | one iteration (rebuilt each) | `buildContext` closure | **✗** | [AiChatPanel.tsx:929-969](apps/web/src/components/ai/AiChatPanel.tsx#L929-L969) |
| W5 | `executedSteps` | what this run actually applied | one run | closure array | **✗** | [AiChatPanel.tsx:1888-1900](apps/web/src/components/ai/AiChatPanel.tsx#L1888) |
| W6 | fact scope | facts consulted by *one* decision | one decision | module singleton | ✓ (drained into rows) | [stream.ts:704-712](apps/web/src/ai/experience/stream.ts#L704-L712) |

**[EXISTS] W4 is rebuilt on every loop iteration, not carried.** `buildContext` is passed as a
thunk to the agent loop and re-invoked per iteration
([AiChatPanel.tsx:1443-1446](apps/web/src/components/ai/AiChatPanel.tsx#L1443-L1446)), with the
comment *"Fresh timeline slice each iteration"*
([:1440-1441](apps/web/src/components/ai/AiChatPanel.tsx#L1440)).

**[EXISTS] W6 is the only working-memory store with a correctness invariant.** *"A fact belongs
to exactly one decision"* — facts observed with no scope open are **rejected, never buffered
forward**, and re-opening a scope **discards** the previous one's facts
([stream.ts:695-712](apps/web/src/ai/experience/stream.ts#L695-L712)). **[EXISTS]** It is also
unwired: `beginDecision`/`observeFact` have zero production call sites.

**[EXISTS] W3 is a plain `const`, not a ref, deliberately** — the comment at
[:1743](apps/web/src/components/ai/AiChatPanel.tsx#L1743) says *"Live reasoning is tracked
locally (state updates are async)"*.

---

# PART 5 — Deliberation

**[EXISTS]** Five sites where thinking happens, and one loop that drives them.

| Site | Starts | Ends | Interruptible? | Reference |
|---|---|---|---|---|
| Reflex / rules (tier 0–1) | `routePrompt` | returns synchronously | n/a (<5ms) | [router.ts:164](apps/web/src/ai/brain/router.ts#L164) |
| Semantic (tier 2) | `routePromptSemantic` | escalate or plan | ✗ | [semantic.ts:1046](apps/web/src/ai/brain/semantic.ts#L1046) |
| World hypothesis | `hypothesis-route` | plan / clarify / escalate | ✗ | [hypothesis-route.ts:228-242](apps/web/src/ai/world/hypothesis-route.ts#L228-L242) |
| LLM fast lane | gated by `looksTransactional` **and** `isRuleTrusted` | 10s timeout abort | **clock only** | [fast.ts:188,199-203](apps/web/src/ai/brain/fast.ts#L188) |
| LLM planner (tier 3–4) | `LlmPlanner.plan` | stream `done` | **✗ — no signal** | [LlmPlanner.ts:107,266-270](apps/web/src/ai/planner/LlmPlanner.ts#L107) |
| Agent loop | `runAgentLoop` | `stopped ∈ {done,cancelled,cap,error,offline}` | **cooperative, between steps** | [AgentLoop.ts:83,78,95](apps/web/src/ai/agent/AgentLoop.ts#L83) |

**[EXISTS] Control is owned by React throughout.** `runAgentLoop` is awaited inside
`handleSubmit`; `deps.isCancelled` reads a React ref
([AiChatPanel.tsx:1833](apps/web/src/components/ai/AiChatPanel.tsx#L1833)); the approval gate
resolves through `approvalResolveRef`. Cancellation detail is established in
[`ORIS_RUNTIME_STATE_AUDIT.md`](ORIS_RUNTIME_STATE_AUDIT.md) Part 4 and is not restated.

**[EXISTS] Deliberation is gated by reflection.** Three of the five sites consult `isRuleTrusted`
before firing ([router.ts:164,671](apps/web/src/ai/brain/router.ts#L164),
[fast.ts:188](apps/web/src/ai/brain/fast.ts#L188),
[hypothesis-route.ts:228,242](apps/web/src/ai/world/hypothesis-route.ts#L228)). This is the
closure of Loop A (Part 8).

---

# PART 6 — Action

**[EXISTS]** The action path and its irreversibility boundary.

```
plan (W1) ──approve──► executePlan ──► registry action (Zod) ──► setGraph ──► commit choke point
                       PlanExecutor.ts:57                                     EditorPage.tsx:3255
                       per-step onProgress                                    │
                       {running|done|failed|skipped}  :65-140                 ├─ appendEditCommit
                                                                              └─ appendHistoryAction
```

**[EXISTS] Intention becomes irreversible at the composition write, not at the registry call.**
The choke point records `graphVersion` and `undoDepth` *after* the write
([EditorPage.tsx:3261-3262](apps/web/src/pages/EditorPage.tsx#L3261-L3262)), and observation
there is bounded by rule U10: *"observation here is strictly additive and may never alter commit
semantics"* ([:3252-3254](apps/web/src/pages/EditorPage.tsx#L3252-L3254)), wrapped in a
`try/catch` — *"An observer may never break what it observes"*
([:3271-3273](apps/web/src/pages/EditorPage.tsx#L3271-L3273)).

**[EXISTS] Actions are observable before commit — but only inside React.** W1 holds a fully
structured plan for a human-scale duration during `phase === "review"`
([AiChatPanel.tsx:1280](apps/web/src/components/ai/AiChatPanel.tsx#L1280)), and per-step status
flows through a callback ([PlanExecutor.ts:65](apps/web/src/ai/executor/PlanExecutor.ts#L65)).
Neither is reachable from another subsystem.

**[EXISTS] Background action** — proxy generation, transcode, waveform, filmstrip — is
module-owned, gated by A1, and reports `{queued, active}`
([sourceProxyEngine.ts:98-99](apps/web/src/editor/performance/sourceProxyEngine.ts#L98-L99)). It
runs with no React involvement beyond the initial kick.

---

# PART 7 — Reflection

**[EXISTS] Reflection is real, shipped, and closed. Five independent learning stores feed future
behaviour.**

| # | Store | Written by | Read by | Effect on behaviour |
|---|---|---|---|---|
| R1 | Rule trust counters | `recordRuleFired/Confirmed/Rejected` | `isRuleTrusted` | **a distrusted rule stops fast-pathing** |
| R2 | Plan cache v2 | `storeCachedPlan` | `lookupCachedPlan` | **an exact repeat replays for free** |
| R3 | Learned phrases | `maybeLearnPhrase` → `learnPhrase` | semantic routing | **a new phrasing joins tier 2** |
| R4 | Memory facts | `rememberFacts` | `selectMemorySlice` → context | **preferences enter the prompt** |
| R5 | Transcript | `pushMessage`/`pushItem` | `buildContext` → `history` | **conversation enters the prompt** |

**[EXISTS] R1 call sites.** Positive: [AiChatPanel.tsx:1409](apps/web/src/components/ai/AiChatPanel.tsx#L1409),
[2023](apps/web/src/components/ai/AiChatPanel.tsx#L2023),
[2046](apps/web/src/components/ai/AiChatPanel.tsx#L2046). Negative:
[1985](apps/web/src/components/ai/AiChatPanel.tsx#L1985),
[2035](apps/web/src/components/ai/AiChatPanel.tsx#L2035),
[2050](apps/web/src/components/ai/AiChatPanel.tsx#L2050). Gate:
`isRuleTrusted` is Laplace-smoothed and requires ≥2 explicit signals before distrust, recovering
if later 👍s outweigh 👎s ([feedback.ts:73-77](apps/web/src/ai/brain/feedback.ts#L73-L77)).

> **[EXISTS] Correction to a sibling document.**
> [`ORIS_RESEARCH_PROGRAMME.md`](ORIS_RESEARCH_PROGRAMME.md) §12.1 records, under Finding 0:
> *"`recordRuleRejected` and `recordRuleConfirmed` are exported by `brain/feedback.ts` and called
> **only from eval tests** — no production call site exists. The B6 learning loop's negative
> signal is currently dead in the running app."*
> **That is no longer true on this branch.** Both have production call sites, listed above. The
> negative signal is live. Recorded here because that note is cited as a known gap.

**[EXISTS] R2/R3 call sites.** `storeCachedPlan(prompt, firstContext, executedSteps)` and
`maybeLearnPhrase(prompt, executedSteps)` at
[AiChatPanel.tsx:1896,1900](apps/web/src/components/ai/AiChatPanel.tsx#L1896); read at
[semantic.ts:1048](apps/web/src/ai/brain/semantic.ts#L1048), itself gated on
`isRuleTrusted("t2.plan-cache")` — **R1 gates R2**.

**[EXISTS] R4/R5.** `rememberFacts(extractFacts(batchPlan, …))` at
[AiChatPanel.tsx:1793](apps/web/src/components/ai/AiChatPanel.tsx#L1793); consumed via
`selectMemorySlice(loadFacts(), { projectId })` into `context.memory`
([:956,963](apps/web/src/components/ai/AiChatPanel.tsx#L956)). Transcript → `history` at
[:942-950](apps/web/src/components/ai/AiChatPanel.tsx#L942-L950).

## 7.1 The finding that matters most

**[EXISTS] The Experience Stream — the substrate purpose-built for reflection — is outside every
loop.** An exhaustive search for readers of `listExperience`, `listDecisions`, `listEpisodes`,
`segment`, and `experienceStats` returns **exactly two call sites, both in the observatory
panel**: [AiThinkingPanel.tsx:252-253](apps/web/src/components/ai/AiThinkingPanel.tsx#L252-L253)
and [:266](apps/web/src/components/ai/AiThinkingPanel.tsx#L266) (`copy json`).

**No cognitive path reads it.** It is write-only with respect to behaviour.

**[EXISTS] The routing ledger is nearly the same.** `listRoutes` has **zero** consumers;
`summarizeRouting` has two — the insights dashboard
([AiInsightsDashboard.tsx:26](apps/web/src/components/ai/AiInsightsDashboard.tsx#L26)) and the
user-profile observer ([user-profile.ts:31](apps/web/src/ai/world/observers/user-profile.ts#L31)).

**[INFERRED]** The system's reflection is therefore **ad hoc rather than architectural**: five
purpose-built small stores each close their own loop, while the general-purpose journal designed
to subsume them closes none. *Inference step:* "designed to subsume them" is read from
[stream.ts:1-10](apps/web/src/ai/experience/stream.ts#L1-L10) and the programme's Stage A goal;
the stores' independence is read from their imports.

**[EXISTS]** This is consistent with the stream's own stated scope — *"Stage A is an OBSERVATORY,
not intelligence. Nothing here adapts, learns, or decides."*
([stream.ts:9](apps/web/src/ai/experience/stream.ts#L9)). The finding is not that it violates its
design; it is that **the reflection stage of the implicit cycle is served by five other things.**

---

# PART 8 — Feedback loops

**[EXISTS] Eight closed loops found.** Every arrow cites code.

```
╔═══ LOOP A · RULE TRUST (mind) ══════════════════════════════════════════════════╗
║ deliberation → outcome → trust store → deliberation                              ║
║   recordRuleConfirmed  AiChatPanel:1409,2023,2046                                ║
║   recordRuleRejected   AiChatPanel:1985,2035,2050                                ║
║        └─► feedback.ts store (localStorage)                                      ║
║             └─► isRuleTrusted  feedback.ts:77                                    ║
║                  ├─► router.ts:164   (rule tier gate)                            ║
║                  ├─► router.ts:671   (compiled tier gate)                        ║
║                  ├─► fast.ts:188     (LLM fast-lane gate)                        ║
║                  └─► hypothesis-route.ts:228,242 (clarify + mood gates)          ║
╚═════════════════════════════════════════════════════════════════════════════════╝

╔═══ LOOP B · PLAN CACHE (mind) ══════════════════════════════════════════════════╗
║   storeCachedPlan  AiChatPanel:1896  ─► localStorage "orreris.brain.plancache.v2"║
║        └─► lookupCachedPlan  semantic.ts:956, called :1048                       ║
║             └─► gated by isRuleTrusted("t2.plan-cache")  semantic.ts:1049        ║
║                 ⚠ LOOP A GATES LOOP B — a nested control loop                    ║
╚═════════════════════════════════════════════════════════════════════════════════╝

╔═══ LOOP C · PHRASE LEARNING (mind) ═════════════════════════════════════════════╗
║   maybeLearnPhrase  AiChatPanel:1900 ─► learnPhrase  semantic.ts:810             ║
║        └─► skeleton store ─► semantic routing (tier 2)                           ║
╚═════════════════════════════════════════════════════════════════════════════════╝

╔═══ LOOP D · MEMORY → PROMPT (mind) ═════════════════════════════════════════════╗
║   rememberFacts(extractFacts(batchPlan))  AiChatPanel:1793                       ║
║        └─► loadFacts ─► selectMemorySlice  AiChatPanel:956                       ║
║             └─► context.memory / memoryNote  :963-964 ─► planner prompt          ║
╚═════════════════════════════════════════════════════════════════════════════════╝

╔═══ LOOP E · TRANSCRIPT → PROMPT (mind) ═════════════════════════════════════════╗
║   pushMessage/pushItem ─► transcript (persisted per project)                     ║
║        └─► buildContext history  AiChatPanel:942-950 ─► planner prompt           ║
║   also: lastActionRef ─► context.lastAction  :961 (intent continuity)            ║
╚═════════════════════════════════════════════════════════════════════════════════╝

╔═══ LOOP F · SELF-MODEL (mind → world → ?) ══════════════════════════════════════╗
║   listRuleStats + summarizeRouting  user-profile.ts:30-31                        ║
║        └─► fact "user.aiProfile" {distrustedRuleIds, instantShare, tokensSaved}  ║
║             user-profile.ts:14-27                                                ║
║        └─► signature = the summary itself → auto-invalidates on any new 👍/👎     ║
║             user-profile.ts:~68                                                  ║
║   ⚠ CLOSURE UNVERIFIED — see [UNKNOWN U1]                                        ║
╚═════════════════════════════════════════════════════════════════════════════════╝

╔═══ LOOP G · ADAPTIVE QUALITY (body) ════════════════════════════════════════════╗
║   compositor ─► recordPlaybackFrame  frame-stats.ts:150                          ║
║        └─► subscribeFrameStats(evaluate)  adaptive-quality.ts:146                ║
║             └─► scale cap  :150 ─► viewer applies min(profileScale, cap)          ║
║                  └─► noteRenderScale  frame-stats.ts:173 ─► back into stats      ║
║   FULLY MODULE-OWNED · SUBSCRIBE-BASED · SURVIVES TEARDOWN                       ║
╚═════════════════════════════════════════════════════════════════════════════════╝

╔═══ LOOP H · HOMEOSTASIS (body) ═════════════════════════════════════════════════╗
║   setInterval(checkMemory)  degradation.ts:130   ← THE ONLY UNPROMPTED TICK      ║
║   onLongTask(…) ─► evaluatePressure  degradation.ts:125-129                      ║
║        └─► setBackgroundGate("pressure"|"memory")  :77,92,108,116                ║
║             └─► gate closes ─► background work parks  backgroundScheduler:58-75  ║
║                  └─► pressure falls ─► gate opens ─► work resumes                ║
║   also clears thumbnail + audio-peak caches on over-threshold  :112-113          ║
╚═════════════════════════════════════════════════════════════════════════════════╝

╔═══ THE SINGLE BRIDGE BETWEEN BODY AND MIND ═════════════════════════════════════╗
║   A1 gate ──► whenBackgroundIdle()  backgroundScheduler.ts:67                    ║
║        └─► awaited by schedulePerception for idle/speculative  scheduler.ts:38-40║
║   That is the ONLY path by which body state reaches cognition.                   ║
╚═════════════════════════════════════════════════════════════════════════════════╝
```

## 8.1 Loops that do **not** exist

**[EXISTS]** Searched for and not found:

| Candidate loop | Status | Evidence |
|---|---|---|
| Experience Stream → planner / context | **ABSENT** | only 2 readers, both in the panel (§7.1) |
| Decision trace → context | **ABSENT** | `listDecisions` has zero consumers |
| Routing ledger → routing | **ABSENT** | `listRoutes` has zero consumers; `summarizeRouting` reaches a fact, not a decision |
| Frame stats → cognition | **ABSENT** | no import of `frame-stats` anywhere under `apps/web/src/ai/**` |
| Body state → planning effort | **ABSENT** | A3 does not consult A1 (§3.2) |
| Undo → learning | **PARTIAL** | undo reaches R1 via the panel's feedback path; the choke-point `undo` row reaches no learner |

**[INFERRED]** The absence of *frame stats → cognition* is the concrete falsification of
[`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) §3.2's testable claim that *"cognitive policy must
be visibly modulated by its own body state."* Today it is not: interoceptive signals exist,
subscribe APIs exist, and cognition never reads them. *Inference step:* proven by absence of
imports, which is strong but not identical to proving no path exists.

---

# PART 9 — Missing cognitive stages

| Stage | Verdict | Evidence |
|---|---|---|
| **Perception — body** | **PRESENT** | P1–P3, push, subscribable, survives teardown |
| **Perception — world** | **PRESENT (pull-only)** | P6; no subscription API |
| **Perception — situation (σ)** | **ABSENT** | `setSituation` has zero production call sites |
| **Attention — resource** | **PRESENT** | A1, single shared authority |
| **Attention — perceptual** | **PRESENT** | A2, 3 priorities, concurrency 1 |
| **Attention — cognitive effort** | **PRESENT but ISOLATED** | A3 consults neither A1 nor A2 |
| **Working memory** | **PRESENT but TRAPPED** | W1–W5 React/closure-owned |
| **Deliberation** | **PRESENT but TRAPPED** | control owned by React throughout |
| **Action — foreground** | **PRESENT** | registry → choke point |
| **Action — background** | **PRESENT** | module-owned, gate-driven |
| **Action — pre-commit visibility** | **COMPUTED BUT UNPUBLISHED** | W1 is a structured pending edit, unreachable |
| **Reflection — learning** | **PRESENT** | R1–R5, five closed loops |
| **Reflection — journal** | **PRESENT but OUTSIDE THE CYCLE** | Experience Stream has no behavioural reader |
| **Reflection — calibration** | **ABSENT** | `ledger` producer declared with empty kind list ([stream.ts:81](apps/web/src/ai/experience/stream.ts#L81)) |
| **Self-model** | **IMPLICIT** | Loop F builds one as a fact; closure unverified |
| **Interoception → cognition** | **ABSENT** | no `frame-stats` import under `ai/**` |
| **Free-running cognitive tick** | **ABSENT** | no timer/rAF/idle callback in `ai/**` except dictation |
| **Free-running body tick** | **PRESENT** | [degradation.ts:130](apps/web/src/editor/performance/degradation.ts#L130) |
| **Deliberate non-action (`⊥`)** | **ABSENT** | `phase` has no such value; no representation found |

---

# PART 10 — Cycle diagram

**[EXISTS]** Every arrow cites code. Two disjoint cycles, one bridge.

```
                        ╔═══════════════ THE MIND CYCLE ═══════════════╗
                        ║  React-owned · no unprompted tick             ║
                        ║  persists only through localStorage           ║
                        ╚══════════════════════════════════════════════╝

   PERCEPTION ──────────────────────────────────────────────────────────────┐
   user message  AiChatPanel:228                                            │
   world facts   world/index.ts:25-39 (pull)                                │
        │                                                                   │
        ▼  handleSubmit guard  AiChatPanel:1396                             │
   ATTENTION                                                                │
   tier cascade  router.ts:164,671 · fast.ts:188 · hypothesis-route:228,242 │
   ⚠ gated by Loop A (reflection) ─────────────────────────────────────┐    │
        │                                                              │    │
        ▼  buildContext  AiChatPanel:929-969                           │    │
   WORKING MEMORY                                                      │    │
   W4 context ← history :942 ← memory :956 ← lastAction :961           │    │
        │                                                              │    │
        ▼  setPhase("planning")  :1725                                 │    │
   DELIBERATION                                                        │    │
   runAgentLoop  AgentLoop.ts:83 → planner.plan  LlmPlanner.ts:107     │    │
   stream events → W2/W3  :1746                                        │    │
        │                                                              │    │
        ▼  setPhase("review") :1280 → approval → setPhase("executing") │    │
   ACTION                                                              │    │
   executePlan  PlanExecutor.ts:57 → registry → setGraph               │    │
        └─► commit choke point  EditorPage:3255-3273 ──► Experience row │    │
                                                          ⚠ DEAD END    │    │
        │                                                   §7.1        │    │
        ▼                                                               │    │
   REFLECTION                                                           │    │
   R1 recordRuleConfirmed/Rejected  :1409,1985,2023,2035,2046,2050 ─────┤    │
   R2 storeCachedPlan  :1896 ──► lookupCachedPlan  semantic.ts:1048 ────┤    │
   R3 maybeLearnPhrase :1900 ──► learnPhrase  semantic.ts:810 ──────────┤    │
   R4 rememberFacts    :1793 ──► selectMemorySlice  :956 ───────────────┼────┤
   R5 transcript       ────────► history  :942-950 ─────────────────────┴────┘
                                                        CYCLE CLOSES

                        ╔═══════════════ THE BODY CYCLE ═══════════════╗
                        ║  module-owned · ticks unprompted             ║
                        ║  survives React teardown                     ║
                        ╚══════════════════════════════════════════════╝

   PERCEPTION  recordPlaybackFrame  frame-stats.ts:150
               onLongTask/checkMemory  degradation.ts:125,130  ← THE TICK
        │
        ▼
   ATTENTION   setBackgroundGate  degradation.ts:77,108 · EditorPage:1999,2006,7134
               reasons Set  backgroundScheduler.ts:23
        │
        ▼
   ACTION      work parks/resumes  backgroundScheduler.ts:58-75
               adaptive scale cap  adaptive-quality.ts:150
               cache clears  degradation.ts:112-113
        │
        ▼
   REFLECTION  noteRenderScale  frame-stats.ts:173 ──┐
               stats.memoryActivations  :~107        │
        └──────────────────────────────────────────► PERCEPTION   CYCLE CLOSES

   ── THE ONLY BRIDGE ────────────────────────────────────────────────────────
   body gate ──► whenBackgroundIdle()  backgroundScheduler.ts:67
            ──► awaited by schedulePerception  scheduler.ts:38-40
            ──► world observers (mind's perception)
   Direction: BODY → MIND only. No return path exists (§8.1).
```

---

# PART 11 — Ownership graph

```
MODULE SINGLETONS — survive teardown, tick or push on their own
  backgroundScheduler   reasons:Set  listeners:Set          :23-24    push ✓ sub ✓
  frame-stats           rings + snapshot + listeners         :17-187   push ✓ sub ✓
  degradation           setInterval + PerformanceObserver    :125-130  push ✓ (via gate)
  adaptive-quality      subscribeFrameStats(evaluate)        :146      push ✓ sub ✓
  experience/stream     events[] + listeners                 :870      push ✓ sub ✓  ⚠ no reader
  world/scheduler       queue[] + running                    :29-30    pull   sub ✗
  world/fact-store      facts                                          pull   sub ✗
  brain/feedback        rule stats → localStorage            :58-99    pull   sub ✗
  brain/ledger          route ring → localStorage            :74-135   pull   sub ✗
  brain/semantic        plan cache + phrases → localStorage  :841-956  pull   sub ✗
  ai/memory             facts → localStorage                           pull   sub ✗

REACT-OWNED — destroyed on unmount
  AiChatPanel (LAZY, EditorPage:223)
    phase :230 · think :265 · plan :229 · awaitingInput :255
    runCancelledRef :1170 · transcript :212 · brainTurn :1268
  EditorPage
    isPlaying :953 · undoStackRef · proxyGenAbortRef :993 · localExportAbortRef :782

CLOSURE-TRAPPED — unreachable by construction
  live reasoning accumulator  :1744
  executedSteps               :1888
  buildContext / onEvent      :929, :1746
  PlanExecutor onProgress     PlanExecutor.ts:65
```

**[INFERRED]** The ownership split is almost exactly the body/mind split: every body component is
a module singleton; every mind component that is *live* is React-owned, and every mind component
that is *persistent* is a localStorage-backed module singleton with no subscription. *Inference
step:* the correlation is read off the table; no causal claim is made about why.

---

# PART 12 — Lifetime graph

```
FOREVER (once started, no teardown path exists)
  degradation interval      degradation.ts:130    no clearInterval in file
  adaptive-quality sub      adaptive-quality.ts:146  unsubscribe DISCARDED
  gate listeners            until explicit unsubscribe by caller

PROCESS LIFETIME
  module singletons: reasons Set · frame rings · perception queue · fact store

PERSISTED ACROSS SESSIONS (localStorage)
  rule trust · routing ledger · plan cache v2 · learned phrases · memory facts
  experience stream (1500-row ceiling, stream.ts:410)
  transcript (per project)

COMPONENT LIFETIME (destroyed on unmount)
  phase · think · plan · transcript state · runCancelledRef · isPlaying

ONE RUN (seconds)
  live accumulator · executedSteps · think.reasoning · W4 context (rebuilt per iteration)

ONE DECISION
  fact scope — rejected if no scope open, discarded on re-open  stream.ts:695-712

SUB-FRAME
  frame samples (ring, 180 ≈ 3s)  frame-stats.ts:16
```

---

# PART 13 — Architectural risks

**[EXISTS] K1 · The reflection substrate is outside the cycle.** The Experience Stream has two
readers, both in the observatory panel (§7.1), while five ad-hoc stores carry the actual learning.
**[INFERRED]** Any future consolidation reads a journal that no behaviour depends on, while the
behaviour depends on five stores with independent formats and no shared provenance.

**[EXISTS] K2 · Loop A gates Loop B, giving a nested control loop with no damping analysis.**
`lookupCachedPlan`'s result is discarded unless `isRuleTrusted("t2.plan-cache")`
([semantic.ts:1048-1049](apps/web/src/ai/brain/semantic.ts#L1048)). A single shared rule id
governs the entire plan cache. **[UNKNOWN U2]** whether two 👎s on unrelated cached plans disable
the cache globally for that user.

**[EXISTS] K3 · Five learning stores, five formats, one localStorage namespace, no common
eviction.** `orreris.brain.plancache.v2` ([semantic.ts:841](apps/web/src/ai/brain/semantic.ts#L841)),
rule stats, routing ring, memory facts, transcript, plus `orreris.oris.experience.v4`
([stream.ts:406](apps/web/src/ai/experience/stream.ts#L406)). Only the Experience Stream declares
a ceiling and reports eviction.

**[EXISTS] K4 · Two permanent loops cannot be stopped.** No `clearInterval` in
[degradation.ts](apps/web/src/editor/performance/degradation.ts); the unsubscribe from
`subscribeFrameStats` is discarded at
[adaptive-quality.ts:146](apps/web/src/editor/performance/adaptive-quality.ts#L146). **[INFERRED]**
Benign today (both are cheap and idempotent) and a hazard for any future test harness or
multi-editor page that expects teardown.

**[EXISTS] K5 · The mind cannot feel the body.** No module under `apps/web/src/ai/**` imports
`frame-stats`, and A3 consults neither A1 nor A2. The bridge is one-way and reaches only the
perception scheduler, never the tier cascade.

**[EXISTS] K6 · The whole mind cycle depends on one lazily-mounted component.** `AiChatPanel` is
`lazy()`-imported ([EditorPage.tsx:223](apps/web/src/pages/EditorPage.tsx#L223)) and owns eleven
liveness primitives plus the write sites for four of the five learning loops (R1–R4 all call from
inside it).

**[EXISTS] K7 · Reflection writes are co-located with the UI, not with the action.** R1–R4 fire
from `AiChatPanel`, not from the registry or the commit choke point. **[INFERRED]** A future
non-chat action path would produce actions that no learning loop observes.

---

# PART 14 — Unknowns

- **[U1]** Whether Loop F actually closes. `user.aiProfile` is produced as a fact
  ([user-profile.ts:14-27](apps/web/src/ai/world/observers/user-profile.ts#L14-L27)), but whether
  any planner or router *queries* `user:local` was not traced to a consuming call site.
  *Settle by:* tracing `USER_AI_PROFILE_FACT` consumers through the fact-query path.
- **[U2]** Whether `t2.plan-cache` distrust disables the cache globally per user (K2).
  *Settle by:* reading the trust gate against the cache's key granularity.
- **[U3]** Whether `AiChatPanel` unmounts in normal use or only on navigation. Statically it
  *can* (lazy + conditional); frequency unknown.
- **[U4]** The real tier distribution of live traffic — how often the mind cycle rotates at tier
  0/1 versus 3/4. Answerable from the existing corpus with no code.
- **[U5]** Whether any observer is ever scheduled `speculative` in production, i.e. whether
  A2's lowest priority class is ever used. Call sites of `schedulePerception` were not enumerated.
- **[U6]** Whether the degradation interval measurably costs anything when the editor is closed.
  No measurement was taken.
- **[U7]** Whether `learnPhrase`'s skeleton store has a ceiling. Not read.

---

# PART 15 — Speculative

**Contains no findings. Isolated per the evidence rules.**

- The body cycle's shape (module singleton + push + subscribe + permanent tick) is the shape the
  mind cycle lacks. Whether that shape transfers to cognition is untested.
- Loops A–E closing through five separate stores rather than through the journal may be an
  artifact of build order rather than a design position; no document was found stating either.
- Whether an implicit cycle discovered by audit *should* be made explicit is not an
  implementation question and is out of scope.

---

## Appendix A — Deliverable index

| Deliverable | Section |
|---|---|
| Cognitive cycle map | Part 1 (+ Parts 2–7 per stage) |
| Ownership graph | Part 11 |
| Lifetime graph | Part 12 |
| Feedback-loop graph | Part 8 (Loops A–H + §8.1 absences) |
| Missing cognitive stages | Part 9 |
| Architectural risks | Part 13 (K1–K7) |
| Unknowns | Part 14 (U1–U7) |
| Speculative, isolated | Part 15 |
| Cycle diagram | Part 10 |
| Most Important Question | Part 0 |

## Appendix B — Files opened for this audit

`backgroundScheduler.ts` (full) · `degradation.ts` (§95-135) · `adaptive-quality.ts` (exports) ·
`frame-stats.ts` (§1-60, exports) · `world/scheduler.ts` (full) · `world/index.ts` (§1-40) ·
`world/observers.ts` (header) · `world/observers/user-profile.ts` (§1-70) ·
`world/hypothesis-route.ts` (grep) · `brain/feedback.ts` (exports) · `brain/ledger.ts` (exports) ·
`brain/semantic.ts` (§740-1055) · `brain/router.ts` (grep) · `brain/fast.ts` (grep) ·
`ai/experience/stream.ts` (§1-420, §600-720, §860-960) · `ai/agent/AgentLoop.ts` (grep) ·
`ai/executor/PlanExecutor.ts` (exports) · `ai/planner/LlmPlanner.ts` (§107-330) ·
`ai/openai-stream.ts` (full) · `ai/types.ts` (§116-135) · `ai/ollama.ts` (grep) ·
`components/ai/AiChatPanel.tsx` (§212-320, §929-969, §1355-1420, §1440-1620, §1720-1920,
§1960-2110, §2215-2320) · `components/ai/AiThinkingPanel.tsx` (full) ·
`components/ai/AiThinkingLog.tsx` (§1-45) · `pages/EditorPage.tsx` (state, gate writers,
§3249-3275, abort refs) · `editor/oris-write-probe.ts` (header).
