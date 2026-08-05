# ORIS — Live Collaboration State Audit

> **What this file is:** a forensic audit of the shipped runtime, answering one question with
> implementation evidence: *does the codebase already contain the primitives required for live
> collaborative presence?*
>
> **What this file is not:** architecture, design, UI, or proposal. Nothing here is invented.
> Every claim in the EXISTING sections carries a `file:line` reference and was read, not assumed.
>
> **Evidence discipline — enforced throughout.** Four labels, never mixed:
>
> | Label | Meaning |
> |---|---|
> | **[EXISTS]** | Read from the code on this branch. Reference given. Verifiable by opening the file. |
> | **[INFERRED]** | A conclusion that follows from read code but was not itself observed running. The inference step is stated so it can be challenged. |
> | **[UNKNOWN]** | Could not be determined from static reading. Says what measurement would settle it. |
> | **[SPECULATIVE]** | Would require new work. Appears **only** in Part 7, never mixed into findings. |
>
> **Branch:** `method-3-gpu-compositor`, audited 2026-08-04. Sibling docs:
> [`ORIS_OBSERVATORY.md`](ORIS_OBSERVATORY.md) (which raised this question),
> [`ORIS_INTERACTION.md`](ORIS_INTERACTION.md), [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md).

---

## 0. The answer to the Most Important Question

> *"If every UI disappeared tomorrow, could another subsystem still know 'ORIS is currently
> thinking' using only existing runtime state?"*

**No — with a sharp and useful asymmetry that the question does not anticipate.**

```
                    ┌───────────────────────────────────────────────────┐
  THE BODY          │  YES. Live, global, and in two cases SUBSCRIBABLE. │
  is it busy?       │  Survives every UI teardown. Zero React coupling.  │
                    └───────────────────────────────────────────────────┘
                    ┌───────────────────────────────────────────────────┐
  THE MIND          │  NO. Exists only as React component state inside a │
  is it thinking?   │  LAZILY-MOUNTED panel. Unmount destroys it. No     │
                    │  store, context, singleton, or bus holds it.       │
                    └───────────────────────────────────────────────────┘
```

**[EXISTS]** The body's liveness is real, already global, and already used cross-subsystem:
`isBackgroundWorkAllowed()` / `subscribeBackgroundGate()`
([backgroundScheduler.ts:46-55](apps/web/src/editor/performance/backgroundScheduler.ts#L46-L55)),
`getFrameStatsSnapshot()` / `subscribeFrameStats()`
([frame-stats.ts:179-187](apps/web/src/editor/performance/frame-stats.ts#L179-L187)),
`perceptionQueueDepth()` ([scheduler.ts:71](apps/web/src/ai/world/scheduler.ts#L71)),
`window.__rfSourceProxy.{queued, active}`
([sourceProxyEngine.ts:98-99](apps/web/src/editor/performance/sourceProxyEngine.ts#L98-L99)),
plus ~15 further `window.__rf*` telemetry getters.

**[EXISTS]** The mind's liveness is not global. The **only** representations of cognitive
activity in the runtime are two `useState` hooks in one component:

- [`AiChatPanel.tsx:230`](apps/web/src/components/ai/AiChatPanel.tsx#L230) —
  `const [phase, setPhase] = useState<"idle" | "planning" | "review" | "executing">("idle")`
- [`AiChatPanel.tsx:265`](apps/web/src/components/ai/AiChatPanel.tsx#L265) —
  `const [think, setThink] = useState<{ phase: number; reasoning: string; provider?: string }>(…)`

**[EXISTS]** That component is lazily imported and conditionally mounted
([EditorPage.tsx:223](apps/web/src/pages/EditorPage.tsx#L223) —
`const AiChatPanel = lazy(() => import("../components/ai/AiChatPanel")…)`).

**[EXISTS]** A repository-wide search for any global cognitive-activity signal
(`aiBusy`, `isThinking`, `aiState`, `assistantBusy`, `aiActivity`) returns **no production
implementation** — the only hit is a local render variable in
[`AiThinkingLog.tsx:67`](apps/web/src/components/ai/AiThinkingLog.tsx#L67). There are exactly
three `createContext` call sites in the web app
([VideoPreview.tsx](apps/web/src/components/VideoPreview.tsx),
[autoKeyframeContext.ts](apps/web/src/editor/inspector/autoKeyframeContext.ts),
[auth.tsx](apps/web/src/lib/auth.tsx)) and none carries AI state. There is no store directory.

### 0.1 The precise shape of the gap

This is the finding that matters, because it changes the size of the answer:

> **[EXISTS]** The state transitions already exist, at the right moments, with the right values.
> There are **eleven** `setPhase` call sites
> ([1179](apps/web/src/components/ai/AiChatPanel.tsx#L1179),
> [1280](apps/web/src/components/ai/AiChatPanel.tsx#L1280),
> [1444](apps/web/src/components/ai/AiChatPanel.tsx#L1444),
> [1446](apps/web/src/components/ai/AiChatPanel.tsx#L1446),
> [1544](apps/web/src/components/ai/AiChatPanel.tsx#L1544),
> [1602](apps/web/src/components/ai/AiChatPanel.tsx#L1602),
> [1725](apps/web/src/components/ai/AiChatPanel.tsx#L1725),
> [1789](apps/web/src/components/ai/AiChatPanel.tsx#L1789),
> [1918](apps/web/src/components/ai/AiChatPanel.tsx#L1918),
> [2079](apps/web/src/components/ai/AiChatPanel.tsx#L2079),
> [2093](apps/web/src/components/ai/AiChatPanel.tsx#L2093))
> covering every entry to and exit from cognitive work. **They terminate in `setState`.**
> The runtime *computes* live cognitive state and *renders* it. It never *publishes* it.

**[INFERRED]** Therefore the missing implementation is not a new mechanism. It is the application
of a pattern this repository already implements three times independently — a module-level
singleton with a `Set` of listeners and a `subscribe()` returning an unsubscribe closure
([backgroundScheduler.ts:23-55](apps/web/src/editor/performance/backgroundScheduler.ts#L23-L55),
[frame-stats.ts:187](apps/web/src/editor/performance/frame-stats.ts#L187),
[stream.ts:870](apps/web/src/ai/experience/stream.ts#L870) `subscribeExperience`).
*Inference step:* the pattern's suitability is judged from its three existing uses carrying
comparable data (a reason set, a throttled snapshot, an append notification); it was not tested
against cognitive state.

---

# PART 1 — Runtime state map

Every live-state primitive found, by subsystem. `Sub?` = has a subscription API. `Global?` =
reachable from another module without React.

## 1.1 Cognition (AI)

| State | Values | Owner | Global? | Sub? | Reference |
|---|---|---|---|---|---|
| `phase` | `idle · planning · review · executing` | React `useState` | **✗** | ✗ | [AiChatPanel.tsx:230](apps/web/src/components/ai/AiChatPanel.tsx#L230) |
| `think` | `{phase: 0-5, reasoning, provider}` | React `useState` | **✗** | ✗ | [AiChatPanel.tsx:265](apps/web/src/components/ai/AiChatPanel.tsx#L265) |
| `plan` | `AiPlan \| null` — **the pending edit** | React `useState` | **✗** | ✗ | [AiChatPanel.tsx:229](apps/web/src/components/ai/AiChatPanel.tsx#L229) |
| `awaitingInput` | bool — blocked on a clarify question | React `useState` | ✗ | ✗ | [AiChatPanel.tsx:255](apps/web/src/components/ai/AiChatPanel.tsx#L255) |
| `busy` | derived: planning∨executing∨talking | render-local const | ✗ | ✗ | [AiChatPanel.tsx:2278](apps/web/src/components/ai/AiChatPanel.tsx#L2278) |
| `runCancelledRef` | bool — interrupt flag | React `useRef` | ✗ | ✗ | [AiChatPanel.tsx:1170](apps/web/src/components/ai/AiChatPanel.tsx#L1170) |
| `undoableCommits` / `undoing` | int / bool | React `useState` | ✗ | ✗ | [AiChatPanel.tsx:262-263](apps/web/src/components/ai/AiChatPanel.tsx#L262-L263) |
| `speaking` / `talking` / `voiceSession` | bool | React `useState` | ✗ | ✗ | [AiChatPanel.tsx:276,303,432](apps/web/src/components/ai/AiChatPanel.tsx#L276) |
| per-step progress | `running · done · failed · skipped` | callback param | ✗ | ✗ | [PlanExecutor.ts:65-140](apps/web/src/ai/executor/PlanExecutor.ts#L65-L140) |
| `stopped` (run outcome) | `done · cancelled · cap · error · offline` | return value | ✗ | ✗ | [AgentLoop.ts:78](apps/web/src/ai/agent/AgentLoop.ts#L78) |
| perception queue depth | int | module singleton | **✓** | **✗** | [scheduler.ts:71](apps/web/src/ai/world/scheduler.ts#L71) |
| Experience Stream | completed events | module singleton | **✓** | **✓** | [stream.ts:870](apps/web/src/ai/experience/stream.ts#L870) |

**[EXISTS]** Eleven of thirteen cognitive-state primitives are React-owned and unreachable. The
two that are global are the perception queue (depth only — **no identity of what is running, and
no subscription**) and the Experience Stream (**completed events only** — the retrospective
property [`ORIS_OBSERVATORY.md`](ORIS_OBSERVATORY.md) §3.2 identified).

## 1.2 Body / scheduling

| State | Values | Owner | Global? | Sub? | Reference |
|---|---|---|---|---|---|
| background gate | `Set<playing·gesture·exporting·pressure·memory>` | module singleton | **✓** | **✓** | [backgroundScheduler.ts:21-55](apps/web/src/editor/performance/backgroundScheduler.ts#L21-L55) |
| gate holds counter | int | module singleton | **✓** (getter) | ✗ | [backgroundScheduler.ts:79-82](apps/web/src/editor/performance/backgroundScheduler.ts#L79-L82) |
| frame stats | fps, avgDrawMs, droppedRatio, severeCount, renderScale, **playing**, mediaFps | module singleton | **✓** | **✓** | [frame-stats.ts:21-187](apps/web/src/editor/performance/frame-stats.ts#L21-L187) |
| degradation | pressure / memory → gate | module | **✓** (via gate) | ✓ | [degradation.ts:77-116](apps/web/src/editor/performance/degradation.ts#L77-L116) |
| source-proxy engine | `{built, failed, skipped, queued, **active**, lastBuildMs, recent}` | window getter | **✓** | ✗ | [sourceProxyEngine.ts:98-99](apps/web/src/editor/performance/sourceProxyEngine.ts#L98-L99) |
| perception priority queue | `user-blocking · idle · speculative`, concurrency 1 | module singleton | **✓** (depth) | ✗ | [scheduler.ts:17-71](apps/web/src/ai/world/scheduler.ts#L17-L71) |

## 1.3 Editor

| State | Values | Owner | Global? | Sub? | Reference |
|---|---|---|---|---|---|
| `isPlaying` | bool | React `useState` + ref mirror | ✗ | ✗ | [EditorPage.tsx:953,984](apps/web/src/pages/EditorPage.tsx#L953) |
| gesture active | via gate `"gesture"` | pointer handlers → gate | **✓** | ✓ | [EditorPage.tsx:2006-2017](apps/web/src/pages/EditorPage.tsx#L2006-L2017) |
| exporting | via gate `"exporting"` | gate | **✓** | ✓ | [EditorPage.tsx:7134,7179](apps/web/src/pages/EditorPage.tsx#L7134) |
| commit intent | `{initiator, actionIds, summary, history}` | call-site param | ✗ | ✗ | [gesture-scope.ts `CommitIntent`](apps/web/src/editor/gesture-scope.ts) |
| commit event | post-hoc row | Experience Stream | **✓** | **✓** | [EditorPage.tsx:3255-3273](apps/web/src/pages/EditorPage.tsx#L3255-L3273) |
| undo stack depth | int | `undoStackRef` | ✗ | ✗ (published at commit) | [EditorPage.tsx:3262](apps/web/src/pages/EditorPage.tsx#L3262) |

## 1.4 Rendering / decode

| State | Values | Owner | Global? | Sub? | Reference |
|---|---|---|---|---|---|
| readiness clocks | `blockedSince` / `staleSince` per source | caller-held maps | ✗ | ✗ | [scene-readiness.ts:56-106](apps/web/src/playback/scene-readiness.ts#L56-L106) |
| readiness decision | which gate fired (not-ready vs coherence) | pure fn return | ✗ | ✗ | [scene-readiness.ts:88-106](apps/web/src/playback/scene-readiness.ts#L88-L106) |
| coherence | staleness seconds, hold decision | pure fns + window getter | **✓** (telemetry) | ✗ | [temporal-coherence.ts:117,182-267](apps/web/src/playback/temporal-coherence.ts#L117) |
| WebCodecs pool | session leases, idle cache | module | **✓** (`__rfWcPool`) | ✗ | [preview-frame-pool.ts:47](apps/web/src/playback/preview-frame-pool.ts#L47) |
| read-ahead headroom | decode vs consume rate | module | **✓** (`__rfReadahead`) | ✗ | [readahead-probe.ts:31](apps/web/src/playback/readahead-probe.ts#L31) |
| ~15 further `__rf*` | render cost, holds, freeze, swaps, hotspots, HDR, degradation, video pool | window getters | **✓** | ✗ | various |

**[EXISTS] The three-tier visibility structure.** This is the audit's organising result:

```
TIER 1  SUBSCRIBABLE SINGLETON   3 instances  background gate · frame stats · experience stream
TIER 2  GLOBAL, POLL-ONLY       ~18 instances  every window.__rf* getter · perceptionQueueDepth
TIER 3  REACT / CLOSURE-TRAPPED  all cognition · isPlaying · readiness clocks · undo depth
```

**[INFERRED]** Tier 2 is where most body state sits. It is readable but not observable: a consumer
must poll, and polling on the main thread is exactly what ORIS-6 forbids. *Inference step:* no
`__rf*` getter examined exposes a listener registry — each is a bare `get:` or a lazily-created
plain object.

---

# PART 2 — Lifetime diagram

**[EXISTS]** Traced from `handleSubmit` through `runAgentLoop` to commit.

```
t
│  USER SUBMITS                                       AiChatPanel.tsx handleSubmit
│    ├─ guard: if phase ∈ {planning, executing} → return           :1396   ← already-busy check
│    ├─ approval-word intercept (yes/no → apply/cancel)            :1357-1368
│    └─ clarify-answer intercept (resolves pendingInputRef)        :1376-1390
│
├─ REFLEX / BRAIN TIER                          lifetime: <5ms–150ms, 0 tokens
│    └─ resolves → recordDecisionTrace → stream row               :1470
│       ⚠ NEVER ENTERS `phase`. A tier-0/1 turn is invisible to every liveness
│         consumer, because setPhase("planning") is only reached on the LLM path.
│
├─ setPhase("planning")                                            :1725
│  │  ┌──────────────────────────────────────────────────────────────────┐
│  │  │ think = {phase:0, reasoning:""}                            :1742 │
│  │  │ live = {reasoning, provider, started: performance.now()}   :1744 │  ← plain closure obj
│  │  └──────────────────────────────────────────────────────────────────┘
│  │
│  ├─ runAgentLoop(prompt, deps)                       AgentLoop.ts:83
│  │   │  per iteration:
│  │   ├─ if (deps.isCancelled()) → stopped:"cancelled"          :95,124,161,232
│  │   ├─ buildContext() → setPhase("planning")   AiChatPanel:1444  ← re-entered per iteration
│  │   ├─ planner.plan(prompt, ctx, onEvent)                     :114
│  │   │    └─ LlmPlanner.plan                     LlmPlanner.ts:107
│  │   │        ├─ onEvent{phase:0}                              :111
│  │   │        ├─ onEvent{phase:1}, onEvent{phase:2}            :130-131
│  │   │        ├─ streamLocal(…) or streamRequest(…)            :141,154
│  │   │        │    └─ NDJSON reader loop                       :282-322
│  │   │        │        ├─ "provider" → onEvent{provider}, {phase:3}  :299-300
│  │   │        │        ├─ "reasoning" → onEvent{delta}, {phase:3}    :302-307
│  │   │        │        └─ "answer" → onEvent{phase:4}                :309-310
│  │   │        └─ buildPlan(…)  → validation → phase 5
│  │   │
│  │   ├─ setPhase("executing")                    AiChatPanel:1544
│  │   ├─ executeBatch → executePlan             PlanExecutor.ts:57
│  │   │    └─ per step: onProgress{status:"running"} → …"done"|"failed"|"skipped"  :65-140
│  │   └─ commitThought() → transcript row "Thought for Ns"   AiChatPanel:1755
│  │
│  └─ setPhase("idle")                                            :1602/1918
│
└─ EDITOR COMMIT (may be interleaved, or user-driven, any time)
     └─ commit choke point → appendEditCommit/appendHistoryAction  EditorPage.tsx:3255-3273
```

## 2.1 Lifetimes, and what disappears before it could be observed

| Object | Begins | Ends | Duration **[INFERRED]** | Observable externally? |
|---|---|---|---|---|
| `phase = "planning"` | [:1725](apps/web/src/components/ai/AiChatPanel.tsx#L1725) | [:1602](apps/web/src/components/ai/AiChatPanel.tsx#L1602)/[:1918](apps/web/src/components/ai/AiChatPanel.tsx#L1918) | seconds | **No** |
| `think.reasoning` | first delta | `commitThought()` | seconds | **No** — folded into a transcript row |
| `live` closure object | [:1744](apps/web/src/components/ai/AiChatPanel.tsx#L1744) | function scope exit | one run | **No** — plain local, not even a ref |
| `plan` (pending edit) | plan built | apply/cancel/modify | **seconds→minutes** (human latency) | **No** |
| per-step `running` | [:65](apps/web/src/ai/executor/PlanExecutor.ts#L65) | next status | ms–s | **No** — callback only |
| reflex-tier turn | submit | trace row | **<5ms–150ms** | **No live state at all** |
| `AiPlan` in `review` | approval shown | resolved | unbounded | **No** |
| Experience row | after completion | eviction @1500 | permanent-ish | **Yes** — subscribable |
| gate reason | condition start | condition end | ms–minutes | **Yes** — subscribable |

**[EXISTS] The disappearance finding.** Two classes vanish before any external observer could see
them, for different reasons:

1. **The reflex/brain tier never enters `phase` at all.** `setPhase("planning")` is reached at
   [:1725](apps/web/src/components/ai/AiChatPanel.tsx#L1725), *after* the tier-0/1 branch has
   already returned at [:1470-1487](apps/web/src/components/ai/AiChatPanel.tsx#L1470-L1487). A
   locally-resolved turn produces a completed Experience row and **zero** liveness state.
2. **The `live` object is not even a ref** ([:1744](apps/web/src/components/ai/AiChatPanel.tsx#L1744)) —
   it is a plain `const` in the async function's closure, deliberately, because "state updates
   are async" (the comment at [:1743](apps/web/src/components/ai/AiChatPanel.tsx#L1743)). It is
   the most accurate live record of the current reasoning and it is the least reachable object
   in the entire path.

**[INFERRED]** The `plan`-in-`review` lifetime is the longest-lived and most observable-in-principle
cognitive state in the system — it persists for human-scale durations by design, and it is a fully
structured pending edit. *Inference step:* duration is inferred from it being gated on a user
click ([ApprovalBar at :2512](apps/web/src/components/ai/AiChatPanel.tsx#L2512)), not measured.

---

# PART 3 — Ownership graph

```
                        ┌─────────────────────────────────────────┐
                        │  MODULE SINGLETONS  (survive all UI)    │
                        ├─────────────────────────────────────────┤
  writers ─────────────►│  backgroundScheduler  reasons:Set       │◄──── subscribeBackgroundGate
  EditorPage:1999 playing│                      listeners:Set     │      isBackgroundWorkAllowed
  EditorPage:2006 gesture│                                        │      waitWhileBackgroundBlocked
  EditorPage:7134 export │                                        │      whenBackgroundIdle
  degradation:77 pressure│                                        │      window.__rfBgGate
  degradation:108 memory │                                        │
                        ├─────────────────────────────────────────┤
  ScenePreviewCanvas ──►│  frame-stats  rings + snapshot          │◄──── subscribeFrameStats
                        ├─────────────────────────────────────────┤
  decision-trace ──────►│  experience/stream  events[] + listeners│◄──── subscribeExperience
  EditorPage:3255 ─────►│                                         │      (COMPLETED events only)
                        ├─────────────────────────────────────────┤
  world observers ─────►│  world/scheduler  queue[] + running     │◄──── perceptionQueueDepth()
                        │                                         │      (depth only, no subscribe)
                        └─────────────────────────────────────────┘

                        ┌─────────────────────────────────────────┐
                        │  REACT-OWNED  (destroyed on unmount)    │
                        ├─────────────────────────────────────────┤
   AiChatPanel (LAZY)   │  phase · think · plan · awaitingInput    │   ✗ no consumer outside
   EditorPage:223       │  runCancelledRef · undoableCommits       │     the component tree
                        ├─────────────────────────────────────────┤
   EditorPage           │  isPlaying(+ref) · undoStackRef          │   partial: mirrored INTO
                        │  proxyGenAbortRef · localExportAbortRef  │   the gate, not readable out
                        └─────────────────────────────────────────┘

                        ┌─────────────────────────────────────────┐
                        │  CLOSURE-TRAPPED  (unreachable, period) │
                        ├─────────────────────────────────────────┤
                        │  `live` reasoning accumulator      :1744│
                        │  `onEvent` handler                 :1746│
                        │  PlanExecutor `onProgress` callback   :65│
                        │  scene readiness blockedSince/staleSince │
                        └─────────────────────────────────────────┘
```

## 3.1 Why the cognitive state is trapped — the causes are distinguishable

**[EXISTS]** Three different causes, and they need different answers:

| Cause | Instance | Evidence |
|---|---|---|
| **Owned by a lazily-mounted component** | `phase`, `think`, `plan` | [EditorPage.tsx:223](apps/web/src/pages/EditorPage.tsx#L223) `lazy(() => import(…))` |
| **Deliberately a closure, for correctness** | `live` accumulator | [AiChatPanel.tsx:1743](apps/web/src/components/ai/AiChatPanel.tsx#L1743) — comment: *"state updates are async"* |
| **Callback-shaped by contract** | `onProgress`, `onEvent` | [PlanExecutor.ts:11-30](apps/web/src/ai/executor/PlanExecutor.ts#L11-L30), [types.ts:121](apps/web/src/ai/types.ts#L121) |

**[INFERRED]** The second cause is the interesting one: `live` is a closure *because* React state
is async and the code needs an accurate synchronous accumulator. That is the same argument a
module singleton satisfies — and better, since a singleton is also readable. *Inference step: the
requirement is read from the comment; no alternative implementation was tested.*

**[EXISTS]** The body state is *not* trapped, and the reason is architectural rather than
accidental: `backgroundScheduler` exists precisely so producers "don't subscribe to each condition
separately" ([backgroundScheduler.ts:6-8](apps/web/src/editor/performance/backgroundScheduler.ts#L6-L8)).
The editor already solved cross-subsystem liveness once, for the body. It was never done for the
mind.

---

# PART 4 — Cancellation graph

```
HUMAN INTENT                          MECHANISM                         PREEMPTIVE?
─────────────────────────────────────────────────────────────────────────────────────
Stop button           handleStop  →  runCancelledRef = true        :2220     ✗ cooperative
                                     polled by AgentLoop.isCancelled()
                                     at 4 points: :95 :124 :161 :232
                                     ⚠ comment: "abort the running agent loop
                                       BETWEEN STEPS"                :2219

Reject plan           handleCancel →  setPlan(null); setPhase("idle") :2076   n/a — nothing
                                      approvalResolve(null)                    is running

"no/cancel" spoken    → handleCancelRef.current()                   :1365    same as above

Cancel-shaped answer  regex on model answer → stopped:"cancelled"  AgentLoop:170-172  ✗

NON-HUMAN                             MECHANISM                         TRIGGER
─────────────────────────────────────────────────────────────────────────────────────
fast-tier timeout     AbortController + setTimeout(10_000)   fast.ts:199-203    clock
ollama reachability   AbortController + setTimeout(timeoutMs) ollama.ts:107-110 clock
api health probe      AbortController + setTimeout            api.ts:1310-1313  clock
proxy generation      proxyGenAbortRef.abort()          EditorPage:2605,2613,2621,2637
                      ⚠ triggered by PLAYBACK STARTING, not by the human
local export          localExportAbortRef                 EditorPage:782,7129
worker teardown       worker.terminate()          proxyWorkerClient.ts:200 + 9 other files

NOT CANCELLABLE AT ALL
─────────────────────────────────────────────────────────────────────────────────────
Cloud plan stream     fetch(`${API_URL}/ai/plan/stream`, {method, headers, body})
                      LlmPlanner.ts:266-270  →  NO `signal` PROPERTY
Local plan stream     streamOllamaChat accepts `signal?: AbortSignal`  ollama.ts:126,145
                      streamLocal(…) never supplies one              LlmPlanner.ts:235-242
```

## 4.1 Does cancellation already represent human interruption?

**[EXISTS] No. Three findings, each independently decisive.**

**C1 · Human cancellation is cooperative and polled, never preemptive.** `handleStop`
([:2220](apps/web/src/components/ai/AiChatPanel.tsx#L2220)) sets a boolean; `AgentLoop` reads it
at four fixed points ([:95](apps/web/src/ai/agent/AgentLoop.ts#L95),
[:124](apps/web/src/ai/agent/AgentLoop.ts#L124),
[:161](apps/web/src/ai/agent/AgentLoop.ts#L161),
[:232](apps/web/src/ai/agent/AgentLoop.ts#L232)). The docstring is explicit: *"abort the running
agent loop **between steps**"* ([:2219](apps/web/src/components/ai/AiChatPanel.tsx#L2219)).

**[INFERRED]** A user who presses Stop while a model is mid-generation waits for the generation to
finish before anything stops. *Inference step:* follows from C1 + C2 (no signal on the fetch), but
the observed latency was not measured — see [UNKNOWN U1].

**C2 · The cloud LLM stream is structurally uncancellable.** The `fetch` at
[LlmPlanner.ts:266-270](apps/web/src/ai/planner/LlmPlanner.ts#L266-L270) passes `method`,
`headers`, `body` and **no `signal`**. The NDJSON reader loop
([:282-322](apps/web/src/ai/planner/LlmPlanner.ts#L282-L322)) has no exit condition other than
`chunk.done`. Nothing can interrupt it.

**C3 · The local path's cancellation is plumbed and unused.** `streamOllamaChat` declares
`signal?: AbortSignal` ([ollama.ts:126](apps/web/src/ai/ollama.ts#L126)) and spreads it into the
fetch ([:145](apps/web/src/ai/ollama.ts#L145)). Its only caller, `streamLocal`
([LlmPlanner.ts:235-242](apps/web/src/ai/planner/LlmPlanner.ts#L235-L242)), has no `signal`
parameter and passes none. **The capability exists one call site away from being real.**

**C4 · Every `AbortController` in the AI path is clock-driven, not human-driven.** All three
follow the identical shape `new AbortController()` + `setTimeout(() => controller.abort(), N)`
([fast.ts:199-203](apps/web/src/ai/brain/fast.ts#L199-L203),
[ollama.ts:107-110](apps/web/src/ai/ollama.ts#L107-L110),
[api.ts:1310-1313](apps/web/src/lib/api.ts#L1310-L1313)). They represent *timeout*, not
*interruption*.

**C5 · The editor's aborts represent resource contention, not human intent.** `proxyGenAbortRef`
is aborted when playback starts or live-playback toggles
([EditorPage.tsx:2605](apps/web/src/pages/EditorPage.tsx#L2605),
[2613](apps/web/src/pages/EditorPage.tsx#L2613),
[2621](apps/web/src/pages/EditorPage.tsx#L2621),
[2637](apps/web/src/pages/EditorPage.tsx#L2637)). **[INFERRED]** This is the closest thing in the
codebase to "the human's action pre-empted the machine's work" — the human pressed play, and
speculative work yielded. It is semantically an interruption; it is not recorded as one.

> **Verdict.** The runtime has a rich cancellation vocabulary and **none of it currently means
> "the human interrupted."** It means: a clock expired, a resource was needed, a plan was
> declined, or a loop was told to stop at its next checkpoint.

---

# PART 5 — Streaming graph

```
                     CLOUD                              LOCAL (Ollama)
                     LlmPlanner.streamRequest :262      LlmPlanner.streamLocal :235
                     NDJSON over fetch                  → streamOllamaChat → consumeOpenAiSse
                                                          openai-stream.ts:21

 currently generating   ✓ implicit (reader loop live)   ✓ implicit (reader loop live)
                          :282                            :31
 waiting for 1st token  ✓ phase 3 emitted on provider   ✓ onAnswerStart fires once
                          :299-300                        openai-stream.ts:14,55-57
 receiving tokens       ✓ "reasoning" → onEvent delta   ✓ onReasoning per delta
                          :302-307                        openai-stream.ts:47-50
 first answer token     ✓ "answer" → phase 4  :309-310  ✓ onAnswerStart :55-57
 stream completed       ✓ "done" → done  :315-317       ✓ loop exits, returns {text, reasoning}
 stream paused          ✗ NO SUCH CONCEPT ANYWHERE      ✗ NO SUCH CONCEPT ANYWHERE
 stream cancelled       ✗ no signal (C2)                ~ plumbed, never supplied (C3)
```

**[EXISTS]** The event vocabulary is narrow and closed:
`PlanStreamEvent = {type:"phase"; index} | {type:"provider"; provider} | {type:"reasoning"; delta}`
([types.ts:116-119](apps/web/src/ai/types.ts#L116-L119)). There is **no `{type:"done"}` event** —
completion is signalled by the promise resolving, so a subscriber holding only the event stream
cannot distinguish "finished" from "stalled."

**[EXISTS]** The phase indices are meaningful and already labelled — six steps, with index 3 the
reasoning phase ([AiThinkingLog.tsx:12-22](apps/web/src/components/ai/AiThinkingLog.tsx#L12-L22)):
`Understanding your request · Reading the timeline · Checking available tools · Thinking ·
Drafting the plan · Validating against the editor's tools`.

**[EXISTS]** The display is honest by construction. The component's docstring:
*"Every line here reflects a REAL backend stream event, never a scripted timer… if the planner
stalls, the display stalls with it, honestly"*
([AiThinkingLog.tsx:5-10](apps/web/src/components/ai/AiThinkingLog.tsx#L5-L10)), and per-step
timings come from `performance.now()` at real transitions
([:37-41](apps/web/src/components/ai/AiThinkingLog.tsx#L37-L41)).

**[INFERRED]** This satisfies the honesty discriminator in [`ORIS_OBSERVATORY.md`](ORIS_OBSERVATORY.md)
§2.1 — the display is causally downstream of real state. *Inference step:* verified by reading the
event path end-to-end; not verified by observing a stalled planner.

**[EXISTS] The routing asymmetry.** `consumeOpenAiSse` is imported by exactly one module —
[ollama.ts:13](apps/web/src/ai/ollama.ts#L13). The cloud path has its own hand-rolled NDJSON reader
([LlmPlanner.ts:275-322](apps/web/src/ai/planner/LlmPlanner.ts#L275-L322)). **Two independent
stream parsers with different capabilities** (only one supports `signal`; only one emits
`onAnswerStart`), converging on the same `PlanStreamEvent` vocabulary.

---

# PART 6 — Editor: where does intent exist before the clip changes?

**[EXISTS]** It exists, it is structured, and it is React-owned.

```
INTENT LIFECYCLE

1. plan built            AiPlan { prompt, steps[], confidence, notes[] }
                         └─ steps carry actionId + params            types.ts
2. setPhase("review")    AiChatPanel:1280 — plan held in useState    :229
   ⚠ THIS IS THE PENDING EDIT. Structured, inspectable, unapplied,
     human-scale lifetime. Not reachable outside the component.
3. approval              ApprovalBar onApply/onCancel/onModify       :2512
                         approvalResolveRef resolves with the plan or null
4. executePlan           per-step onProgress{status:"running"}   PlanExecutor:65
5. registry action       Zod-validated, undoable
6. commit choke point    pushedHistoryEntry ? appendEditCommit
                                           : appendHistoryAction   EditorPage:3255-3273
                         ⚠ FIRST moment anything is externally observable
```

**[EXISTS]** `CommitIntent` carries `{initiator, actionIds, summary, history}`
([EditorPage.tsx:3258-3260](apps/web/src/pages/EditorPage.tsx#L3258-L3260)) — authorship is
declared *at* the commit, not before it.

**[EXISTS]** The choke point is wrapped in `try/catch` with the comment *"An observer may never
break what it observes"* ([EditorPage.tsx:3271-3273](apps/web/src/pages/EditorPage.tsx#L3271-L3273))
and U10: *"observation here is strictly additive and may never alter commit semantics"*
([:3252-3254](apps/web/src/pages/EditorPage.tsx#L3252-L3254)).

**[INFERRED]** A pending-edit observer would need a *different* seam from the commit choke point,
because by the time the choke point runs the edit is no longer pending. The natural seam already
exists as a state transition — `setPhase("review")` at
[:1280](apps/web/src/components/ai/AiChatPanel.tsx#L1280) — and it is React-owned.
*Inference step:* no alternative seam was searched for exhaustively.

**[UNKNOWN U2]** Whether direct (non-AI) editor gestures have any pre-commit intent representation.
The write-grain probe ([oris-write-probe.ts](apps/web/src/editor/oris-write-probe.ts)) exists to
answer the related question of write *grain* under `?orisWriteProbe=1`, and its own docstring says
the question *"was going to be answered by intuition otherwise."* **That probe has not been run
here, and this audit does not answer it.**

---

# PART 7 — Live collaboration readiness assessment

## 7.1 Scored against the property, not the aspiration

| Property required for live presence | Present? | Evidence |
|---|---|---|
| Body busy/idle, globally readable | **✓ EXISTS** | `isBackgroundWorkAllowed()` [backgroundScheduler.ts:46](apps/web/src/editor/performance/backgroundScheduler.ts#L46) |
| Body busy/idle, **subscribable** | **✓ EXISTS** | `subscribeBackgroundGate()` [:50](apps/web/src/editor/performance/backgroundScheduler.ts#L50) |
| *Why* the body is busy (typed reasons) | **✓ EXISTS** | 5-value union [:21](apps/web/src/editor/performance/backgroundScheduler.ts#L21) |
| Frame/decode health, subscribable | **✓ EXISTS** | `subscribeFrameStats()` [frame-stats.ts:187](apps/web/src/editor/performance/frame-stats.ts#L187) |
| Speculative-work queue depth | **✓ EXISTS** | `perceptionQueueDepth()`, `__rfSourceProxy.queued` |
| Currently-running speculative task identity | **~ PARTIAL** | `__rfSourceProxy.active` exists; perception queue exposes depth only |
| Mind busy/idle, globally readable | **✗ ABSENT** | `phase` is `useState` [:230](apps/web/src/components/ai/AiChatPanel.tsx#L230) |
| Mind busy/idle, subscribable | **✗ ABSENT** | no publisher exists |
| Which cognitive phase | **~ EXISTS BUT TRAPPED** | 6 labelled phases, event-driven, React-only |
| Live reasoning content | **~ EXISTS BUT TRAPPED** | `live.reasoning` is a bare closure const [:1744](apps/web/src/components/ai/AiChatPanel.tsx#L1744) |
| Pending edit before commit | **~ EXISTS BUT TRAPPED** | `plan` in `review` [:229](apps/web/src/components/ai/AiChatPanel.tsx#L229) |
| Per-step execution progress | **~ EXISTS BUT TRAPPED** | `onProgress` callback [PlanExecutor.ts:65](apps/web/src/ai/executor/PlanExecutor.ts#L65) |
| Attention / σ (what ORIS is looking at) | **✗ ABSENT** | `setSituation` has zero production call sites |
| Waiting-for-first-token | **✓ EXISTS** | phase 3/`onAnswerStart` |
| Preemptive human interruption | **✗ ABSENT** | C1–C4 |
| "ORIS deliberately chose not to act" | **✗ ABSENT** | no representation of `⊥` anywhere |
| Reflex-tier liveness | **✗ ABSENT BY CONSTRUCTION** | tier-0/1 returns before `setPhase` |

**Tally: 6 present · 5 present-but-trapped · 6 absent.**

## 7.2 The assessment

**[INFERRED]** The runtime is **substantially more ready than the previous investigation assumed,
and the readiness is unevenly distributed in a way that matters.**

- **The body is ready now.** A subsystem with no UI can already know that ORIS is loaded, why,
  how badly, and can be *notified* when it changes. Nothing needs building. This is the substrate
  [`ORIS_INTERACTION.md`](ORIS_INTERACTION.md) Candidate E calls for, for the somatic band.
- **The mind is not published, but it is fully computed.** Five of the six missing cognitive
  properties already exist as values at the correct moments. They are trapped, not absent.
- **Two properties are genuinely absent** — attention (σ) and deliberate non-action (`⊥`). These
  are not trapped anywhere; no code computes them.

*Inference step for the whole assessment:* readiness is judged from static reading of state
ownership and reachability. **No runtime measurement was performed.** A consumer subscribing to
these APIs under load has not been tried.

---

# PART 8 — Missing implementation list

Strictly: what does not exist in code. Ordered by how much is missing.

| # | Missing | Size **[INFERRED]** | Evidence it is missing |
|---|---|---|---|
| **M1** | A publisher for cognitive state. The transitions exist at 11 sites; nothing outside React can observe them. | **Small** — the pattern exists 3× in-repo | No `createContext`/store/singleton holds AI state; global-name search returns nothing |
| **M2** | Reflex/brain-tier liveness. Tier-0/1 turns produce no live state at all. | **Small** | `setPhase` is unreachable from the branch returning at [:1470](apps/web/src/components/ai/AiChatPanel.tsx#L1470) |
| **M3** | `signal` on the cloud plan stream. | **Small** | [LlmPlanner.ts:266-270](apps/web/src/ai/planner/LlmPlanner.ts#L266-L270) — no `signal` property |
| **M4** | `signal` passed to the local stream. Plumbing exists; the caller does not supply it. | **Very small** | [ollama.ts:126](apps/web/src/ai/ollama.ts#L126) declares it; [LlmPlanner.ts:235](apps/web/src/ai/planner/LlmPlanner.ts#L235) has no such parameter |
| **M5** | A stream-completion event. Completion is only the promise resolving. | **Small** | `PlanStreamEvent` union has 3 members, none terminal ([types.ts:116](apps/web/src/ai/types.ts#L116)) |
| **M6** | Attention / σ. | **Medium** — many call sites | `setSituation` has zero production callers |
| **M7** | Any representation of deliberate non-action (`⊥`). | **Unknown** | No code computes or stores it; `phase` has no such value |
| **M8** | Subscription on tier-2 globals (`__rf*`, `perceptionQueueDepth`). Poll-only today. | **Small each, ~18 sites** | No listener registry in any getter examined |
| **M9** | Distinguishing human interruption from timeout/contention in the cancellation vocabulary. | **Small** | C1–C5: all paths converge on the same `stopped:"cancelled"` / `abort()` with no cause |
| **M10** | Identity of the currently-running perception job. | **Small** | [scheduler.ts:71](apps/web/src/ai/world/scheduler.ts#L71) returns a number |

---

# PART 9 — Architectural risks

**[EXISTS] R1 · Two independent stream parsers with divergent capabilities.** Cloud
([LlmPlanner.ts:275-322](apps/web/src/ai/planner/LlmPlanner.ts#L275-L322)) and local
([openai-stream.ts:21](apps/web/src/ai/openai-stream.ts#L21)) both produce `PlanStreamEvent` but
only one supports `signal` and only one emits `onAnswerStart`. **[INFERRED]** Any liveness
consumer will observe different fidelity depending on which provider answered — and provider
selection is not the consumer's choice.

**[EXISTS] R2 · The most accurate live cognitive record is the least reachable object.** `live`
([:1744](apps/web/src/components/ai/AiChatPanel.tsx#L1744)) is a bare closure const, chosen over a
ref *because* React state is async. Any publisher must not reintroduce that async-lag bug.

**[EXISTS] R3 · Publishing from the commit choke point is forbidden by an existing rule.** U10:
*"observation here is strictly additive and may never alter commit semantics"*
([EditorPage.tsx:3252-3254](apps/web/src/pages/EditorPage.tsx#L3252-L3254)). **[INFERRED]** A
liveness publisher with subscribers doing synchronous work would violate this if attached there —
the existing `try/catch` bounds throws, not cost.

**[EXISTS] R4 · Polling tier-2 globals costs main-thread time.** ~18 getters, no subscriptions.
**[INFERRED]** A presence consumer polling them on a frame cadence is exactly the starvation
pattern ORIS-6 forbids and this repo has a long history of.

**[EXISTS] R5 · In-flight state is not evidence.** Already ruled in
[`ORIS_OBSERVATORY.md`](ORIS_OBSERVATORY.md) R5 and rooted in ADR-016 I10 (error paths may not
fabricate observations, [stream.ts:257-260](apps/web/src/ai/experience/stream.ts#L257-L260)). A
publisher that wrote pending rows to the Experience Stream would assert occurrences that may never
occur.

**[INFERRED] R6 · The reflex tier is where most traffic resolves, and it is invisible.** The
premise of the whole tier cascade is that most requests resolve at tier 0/1
([AI_ARCHITECTURE.md](AI_ARCHITECTURE.md)). Those turns emit no live state (M2). *Inference step:*
the traffic distribution is asserted by the architecture doc, **not measured here** — see [U3].

**[EXISTS] R7 · `AiChatPanel.tsx` is ~2800 lines and owns eleven liveness primitives.** Any change
touching them touches the largest component in the AI subsystem.

---

# PART 10 — Unknowns

Explicitly not answered by static reading.

- **[U1]** How long a user actually waits after pressing Stop mid-generation. Follows logically
  from C1+C2 but was not measured. *Settle by:* timing `handleStop` → `stopped:"cancelled"` on a
  slow cloud plan.
- **[U2]** Whether direct editor gestures have any pre-commit intent representation. *Settle by:*
  running the existing `?orisWriteProbe=1` instrument.
- **[U3]** The real tier distribution of live traffic. *Settle by:* aggregating `route`/`owner`
  over the existing Experience corpus — no code needed (§7.2 of the observatory report).
- **[U4]** Whether `AiChatPanel` ever actually unmounts in normal use, or only on navigation.
  Static reading proves it *can* (lazy + conditional); frequency is unknown.
- **[U5]** Whether any `__rf*` getter is currently polled by production code on a hot path. Not
  exhaustively traced.
- **[U6]** Cost of a subscription fan-out under load. No measurement exists.

---

# PART 11 — Speculative

**Contains no findings. Nothing here is evidence.** Isolated per the brief's separation rule.

- Publishing cognitive state as a module singleton mirroring `backgroundScheduler`'s shape would
  reuse a proven pattern, but the shape has not been validated against cognitive data.
- Unifying the two stream parsers (R1) would remove the fidelity asymmetry; the cloud parser's
  hand-rolled NDJSON exists for reasons not investigated here.
- Typing cancellation causes (`timeout · contention · human · declined`) would make M9 tractable,
  and would make C5's playback-preempts-proxy case recordable as an interruption.
- Whether any of this *should* be built is not an implementation question and is out of scope.

---

## Appendix A — Deliverable index

| Deliverable | Section |
|---|---|
| Runtime state map | Part 1 (§1.1–1.4, with the three-tier structure) |
| Lifetime diagram | Part 2 (+ §2.1 disappearance analysis) |
| Ownership graph | Part 3 |
| Cancellation graph | Part 4 (+ C1–C5) |
| Streaming graph | Part 5 |
| Live collaboration readiness | Part 7 |
| Missing implementation list | Part 8 (M1–M10) |
| Architectural risks | Part 9 (R1–R7) |
| The Most Important Question | Part 0 |
| Unknowns | Part 10 |
| Speculative, quarantined | Part 11 |

## Appendix B — Files read in full or in relevant part

`AiChatPanel.tsx` · `AiThinkingPanel.tsx` · `AiThinkingLog.tsx` · `AgentLoop.ts` ·
`PlanExecutor.ts` · `LlmPlanner.ts` · `DeterministicPlanner.ts` (signatures) · `ollama.ts` ·
`openai-stream.ts` · `brain/fast.ts` · `decision-trace.ts` · `experience/stream.ts` ·
`ai/types.ts` · `world/scheduler.ts` · `world/index.ts` · `backgroundScheduler.ts` ·
`degradation.ts` (call sites) · `frame-stats.ts` · `sourceProxyEngine.ts` (stats) ·
`proxyWorkerClient.ts` (signatures) · `workerPool.ts` (signatures) · `scene-readiness.ts` ·
`temporal-coherence.ts` · `preview-frame-pool.ts` · `readahead-probe.ts` · `EditorPage.tsx`
(state, gate writers, choke point, abort refs) · `oris-write-probe.ts` · `lib/api.ts` (abort).
