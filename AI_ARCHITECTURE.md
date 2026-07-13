# Kimera Brain — AI Architecture & Build Plan

> **What this file is:** the architecture and phased build plan for Kimera's AI **brain** — the
> tiered decision system that makes the editor itself intelligent and demotes the LLM to a
> last resort. It replaces the old flat phase tracker (that content is preserved in
> [Current state](#current-state--what-already-exists-and-where-it-fits) and the appendices).
>
> **Evidence + input docs:** [`AI_REFINEMENT.md`](AI_REFINEMENT.md) is the raw session log that
> motivated this redesign (keep it — it's the before-picture and the regression corpus).
> [`AI_STRUCTURE_SUGGESTIONS.md`](AI_STRUCTURE_SUGGESTIONS.md) is the brainstorm input; where
> this plan diverges from it, the [divergences section](#where-this-plan-diverges-from-ai_structure_suggestionsmd)
> says why.
>
> **Sibling docs (don't duplicate):** [`AI_FEATURE_MAP.md`](AI_FEATURE_MAP.md) is the
> *where-things-live* file index. [`architecture.md`](architecture.md) is the shipped/deferred
> product log. [`AGENTS.md`](AGENTS.md) is the live multi-agent handoff log.

---

## Philosophy

Kimera is **a professional video editor with an AI operating system on top** — not an "AI video
generator." The editor is fully usable without AI; the AI *operates the editor's tools*:

```
User → Kimera AI → Editor Tools → Timeline / Layers / Effects
```

never `User → AI → Final Video`. **Every AI action is editable and undoable.**

The brain redesign adds one sentence to that philosophy, and it changes everything:

> **The editor knows the project. The LLM only fills gaps.**
>
> Intelligence does not scale — systems do. A request should cost tokens only when it
> genuinely needs language understanding or creativity that the editor's own knowledge
> cannot supply. Everything else is the editor's job, answered in milliseconds for free.

**Golden rules (enforced in code, unchanged):** AI mutates only via the **Timeline Action
Registry**; every step is **registry + Zod param validated** client-side before it can run;
**the renderer is never touched** by AI work; keys stay server-side (except per-request BYO).
`pnpm -r typecheck` is the lint.

---

## The problem (measured, not hypothetical)

[`AI_REFINEMENT.md`](AI_REFINEMENT.md) is a real session transcript. What it shows:

| Request | What happened | What it should be |
|---|---|---|
| "change text color of clip 3 to white" | 3–6 s LLM reasoning + a second 6 s closing call | <50 ms, 0 tokens — one registry action |
| "move clip 3 5 seconds earlier" | 10 s reasoning | <50 ms, 0 tokens |
| "what are your capabilities" | 17 s LLM call | instant — the registries ARE the answer |
| "play the video" / "enter Pan mode" | 9–13 s LLM calls to say "press Space" | instant local answer |
| beat-detect → cut chain | 3 LLM iterations + a closing "already done" iteration | 1 iteration (tool chain), 0 closing call |
| "keyframe the blur amount" | thousands of reasoning tokens re-deriving the answer, three times | instant registry-derived answer (effect params ARE keyframeable since 2026-07; the B5 pre-check answers how-to, or "static per clip" for audio dynamics) |

The six structural failures behind those rows:

1. **Transactional commands pay creative-brain prices.** Single registry actions route through
   a reasoning LLM with the full bounded slice.
2. **Every agent-loop run pays a closing iteration** — after the work is applied, the model is
   called again just to say "done" (and weak models sometimes re-emit the batch instead,
   tripping the loop-breaker).
3. **One model pool for everything.** The gateway is "a prioritized pool of free *reasoning*
   models" — there is no non-reasoning fast class, so even trivial JSON emissions buy a
   40–90 s thought blob.
4. **Registry-answerable questions go to the LLM** (capabilities, editor how-tos).
5. **Known capability gaps are re-discovered by the model at token cost, per turn**, instead
   of being knowledge the system consults instantly.
6. **Nothing learned ever makes the next request cheaper.** The same ask re-pays full cost;
   an undo teaches the system nothing.

---

## Design principles

1. **LLM last.** Every request descends a cascade of tiers ordered by cost; each tier either
   resolves the request with near-certainty or **declines silently** and escalates.
2. **Precision-first fast paths — never guess.** The old deterministic planner earned user
   distrust by chasing *recall* (guessing on ambiguous input and labeling it "Exact"). The
   brain's cheap tiers chase *precision*: they fire only on structurally unambiguous input,
   and the LLM catches everything they decline. A fast path that is sometimes wrong is worse
   than no fast path.
3. **Honest labels per route.** The UI says how a result was produced — "Instant · local"
   vs the actual model name. Never dress a rule match up as model output or vice versa.
4. **Learning = statistics on our own data structures.** Success/undo counters on rules,
   recipes, and phrases (bandit-style Beta scores) — not model training. Feedback the user
   already gives (apply, undo, modify, re-ask) is the reward signal.
5. **Instrument everything.** Every request logs its route, latency, and estimated tokens.
   Savings must be measurable, not vibes.
6. **Safety rules are tier-independent.** Registry-only mutation, destructive-action guards,
   clarify-on-ambiguity, and mode gating (Professional approval) apply identically no matter
   which tier produced the plan.

---

## The decision cascade

```
                        User (chat / voice / UI)
                                  │
                     ┌────────────▼─────────────┐
                     │        THE ROUTER        │  focus state · intent continuity
                     └────────────┬─────────────┘
        ┌──────────┬──────────────┼────────────────┬───────────────┐
        ▼          ▼              ▼                ▼               ▼
   Tier 0       Tier 1         Tier 2           Tier 3          Tier 4
   REFLEX       COMMAND        SEMANTIC         TRANSACTIONAL   CREATIVE BRAIN
   <5ms         COMPILER       LAYER            LLM             (agent loop)
   0 tokens     <50ms          <150ms           1 call          N bounded calls
                0 tokens       0 tokens         ~300 tokens     reasoning models
        │          │              │                │               │
        └──────────┴──────┬───────┴────────────────┴───────────────┘
                          ▼
              Timeline Action Registry (Zod-validated, undoable)
                          │
                  Timeline / Layers / Effects
```

Each tier escalates to the next on anything less than near-certainty. Expected distribution
for a mature brain: **70–90 % of requests resolve at tier ≤ 2 (zero tokens)**.

### Tier 0 — Reflex (<5 ms, 0 tokens) — `apps/web/src/ai/brain/`

Exact and near-exact matches, answered or compiled locally:

- **Command table**: `undo` (the panel's existing AI-undo), `delete clip 3`, `split clip 2 at
  playhead` — resolved via [`clip-reference.ts`](packages/shared/src/clip-reference.ts)
  (ordinals + playhead/selection) into ordinary registry plans.
- **Registry-generated FAQ**: "what can you do", "what are your capabilities" — the answer is
  *generated from* the capability index / tools / skills registries, so it is always current
  and costs nothing. Kills the 17 s capability call.
- **Editor knowledge**: "play the video", "how do I pan" — answered from a small curated table
  of real Kimera shortcuts (the timeline cheat-sheet is the source of truth), instantly and
  correctly (the LLM was *inventing* generic-NLE answers for these).
- **Read-only lookups**: "what is clip 2" — described from the composition slice locally.

### Tier 1 — Command Compiler (<50 ms, 0 tokens)

A grammar, not a guesser: **verb family + target + params → registry action(s)**.

- Verb families and entity extractors already exist
  ([`DeterministicPlanner.ts`](apps/web/src/ai/planner/DeterministicPlanner.ts),
  [`entities.ts`](apps/web/src/ai/planner/entities.ts)) — this tier repurposes that corpus as
  a *precision fast path*, which is a different job from its old *recall fallback* role (the
  offline fallback stays, demoted, for when the LLM is unreachable).
- Fires **only** when the parse is structurally complete: every slot filled, the target
  resolves uniquely (clip-reference / selection / focus state), and the params pass the
  action's own Zod schema. Plus a per-rule feedback-adjusted confidence gate (~0.98, see
  [Learning loop](#learning-loop--the-reinforcement-from-feedback)). Anything less: silent escalation.
- Examples that should compile here: "change clip 3 text to white", "move clip 3 5 seconds
  earlier", "set blur to 10 on clip 2", "fade in clip 1".

### Tier 2 — Semantic layer (<150 ms, 0 tokens)

Local embeddings over a **phrase index** — MiniLM-class model via `@huggingface/transformers`
(lazy singleton, cached, the proven [`local-transcription.ts`](apps/web/src/tools/local-transcription.ts)
pattern; the model downloads once, ~25 MB).

- **Synonym lexicon**: "soften" → blur, "get rid of" → delete.
- **Concept → recipe**: "dreamy" → the Dream look recipe; "cinematic" → the cinematic grade
  skill. Recipes are data (the skills registry), not prompts.
- **Learned user phrases**: mappings the LLM resolved before, cached per user (see Learning
  loop) — the second time "make it pop like last time" is free.
- **Plan cache** (v2 2026-07-11, retargetable): normalized prompt → a previously validated
  plan; replays while every clip the plan REFERENCES is byte-identical (unrelated edits and
  playhead moves don't invalidate). Deictic prompts ("it", "here", "selected") additionally pin
  the exact selection + playhead. LLM turns carry 👍/👎: 👍 blesses the replay, 👎 or an undo
  within 60s forgets the plan + any learned phrase (never auto re-runs the model on 👎 — it
  would repeat itself). Repeats cost nothing, and never wrong-target.
- High similarity threshold; below it, escalate. Same honesty rule: the result is labeled
  "Instant · semantic" and still flows through mode gating.

### Tier 3 — Transactional LLM (1 call, ~300 input tokens)

For commands that *look* transactional but tiers 0–2 couldn't parse:

- A **new gateway model class `fast`** — non-reasoning instruct models (llama-8b-instant
  class, flash-lite class), temperature 0, JSON-only.
- **Micro-prompt**: tool-selection contract only ("emit registry steps or `ESCALATE`"), and a
  **target-clip-only context** (not the full slice).
- Output is validated exactly like any plan; `ESCALATE` or validation failure promotes the
  request to tier 4. One call, no loop, no reasoning tokens.

### Tier 4 — Creative brain (the agent loop, bounded)

The existing [`AgentLoop.ts`](apps/web/src/ai/agent/AgentLoop.ts) — observe → think → act →
observe real results — keeps its role for creative, multi-step, and ambiguous work. Four
upgrades make it dramatically cheaper:

1. **Final-batch contract.** A plan can mark its batch `final: true` and carry a completion
   summary. If every step succeeds, the run ends **without a closing LLM call** — killing the
   wasted "done" iteration every run pays today (and the loop-breaker's weak-model repeats).
2. **Intent DSLs.** Generalize the proven [`GradeIntent`](packages/shared/src/color/grade-intent.ts)
   pattern (LLM emits a compact intent, a deterministic compiler expands it into a real
   editable effect stack): `MotionIntent` (entrance/exit/emphasis animation), `TextLookIntent`
   (styled text treatments), `RecipeRef` (invoke a knowledge-layer recipe by id). Creative
   quality goes up while tokens go down — the model describes *intent*, our compilers do the
   craft.
3. **Slice diffs after iteration 1.** Iteration 1 sends the bounded slice; iterations 2+ send
   only `CHANGES SINCE LAST ACTION` plus `ref` labels for unchanged layers.
4. **Capability-gap pre-check.** Known-impossible asks (e.g. "keyframe the blur amount" today)
   are detected against the capability index *before* planning and answered instantly and
   honestly with the nearest supported alternative — instead of the model burning 40 s
   re-discovering the gap, three times, as in the refinement log.

---

## Cross-cutting systems

### Knowledge layer (the moat)

The [capability index](packages/shared/src/capability-index.ts) grows from a planner grammar
into an **editing ontology** — all data, all local, all token-free:

- **Synonym lexicon** (word → capability) and **concept trees** (mood/style → recipe).
- **Recipes**: the skills registry *is* the recipe store (progressive disclosure already
  built); grow it — looks, intros, genre presets are rows, not prompts.
- **Tool chains**: typed artifact outputs feed the next action without an LLM. Beat detection
  already returns `beats[]` that `addMarkersAtTimes` / `splitClipAtTimes` consume — formalize
  the pattern: any tool's artifact declares which actions can consume it, so "detect beats and
  cut" is one chain, not a conversation.
- **Heuristics**: editing rules (subtitles ≤ 2 lines, music fades in, logos keep safe margin)
  applied by compilers, not asked of a model.
- **Capability gaps**: what is *not* supported, as first-class knowledge (feeds the tier-4
  pre-check and honest answers).

### Working memory / focus state

Extends [`intent-continuity.ts`](apps/web/src/ai/planner/intent-continuity.ts) (the shipped
continue-vs-new classifier) and [`memory.ts`](apps/web/src/ai/memory.ts) into an explicit
session focus: **current target, last action, editing mode**. "Blur it" then resolves at
tier 1 without any history re-send; follow-ups carry deltas only.

### Learning loop — the "reinforcement from feedback"

Honest scope: **bandit-style statistics, not model training.** Every applied plan already
produces the reward signal — the user applies, undoes, modifies, or re-asks.

**Learning happens in TWO STAGES (user requirement, 2026-07-09):**
- **Stage 1 — local (shipping now):** per-user, on-device. Rule trust, learned phrases,
  parameter preferences — the editor adapts to THIS user immediately, privately, for free.
- **Stage 2 — universal (deferred behind consent):** the same events, anonymized (ruleId +
  outcome only, never prompt text), aggregated server-side to train the SHARED editor
  intelligence — global rule/recipe confidence, auto-discovered recipes, learned defaults.
  Every event is recorded aggregate-ready TODAY: `ai/brain/feedback.ts` keeps the bounded raw
  event feed and `drainFeedbackEvents()` is the future sync worker's hook.

- **Outcome events**: explicit **👍/👎 on every brain-resolved turn (✅ shipped)** — 👎 also
  reverts the local edits and re-runs the same prompt through the model — plus `applied` /
  `undone-within-60s` / `modified` / `re-asked` (ahead), recorded per
  plan with the rule/recipe/phrase that produced it.
- **Per-rule, per-recipe, per-phrase Beta(success, failure) scores**, stored in the existing
  MemoryFact-style local-first store (client is source of truth, server sync per user —
  the same contract memory uses today). Effects:
  - a tier-1 rule whose plans keep getting undone **drops below its gate and stops firing**
    (escalates instead) — the system self-corrects toward precision;
  - a phrase the LLM had to resolve is cached as `phrase → plan template`; next time tier 2
    catches it free — **the brain converts tokens into knowledge**;
  - parameter statistics (typical blur amount, favorite font, caption style) feed defaults —
    "blur the intro" uses *your* usual amount.
- **Fleet aggregation is deferred** (no telemetry/consent system yet) but the event schema is
  aggregate-ready: when consented telemetry exists, the same events can build global recipe
  confidence and auto-discovered recipes ("this 5-step sequence appears 12 000 times").

### Context compiler

One module owns what each tier is allowed to send:

| Tier | Context budget |
|---|---|
| 0–2 | none (local state only) |
| 3 | target clip summary only (~300 tokens total request) |
| 4 iter 1 | bounded slice (existing `summarizeContext` rules) |
| 4 iter 2+ | diff since last action + `ref` labels |

Capability docs use progressive disclosure everywhere (skills already do this — extend to
actions/effects): one-liners in the catalog, full doc only via the `inspect` step.

### Instrumentation — the routing ledger

Per request: `{route, provider?, latency ms, est tokens in/out, outcome}` — bounded ring,
surfaced in the Insights panel (route counts, average latency, estimated tokens spent/saved).
Plus a **router acceptance suite** (the 50-prompt ledger reborn, `brain:eval`): a transactional
corpus that must resolve at tier ≤ 2, and an ambiguity corpus that must **escalate** — the
wrong-fast-path count must be **zero**. A rule that fails eval doesn't ship.

---

## Where this plan diverges from AI_STRUCTURE_SUGGESTIONS.md

The brainstorm doc is directionally right (LLM last resort, editor intelligence, layered
routing, learning from behavior). Four deliberate departures:

1. **No trained micro-models / no 4B intent-router model, day 1.** There is no training data
   or infra, and a lexical + embedding router is <150 ms and free. A local tiny-LLM router is
   an exploratory phase (B8) for Ollama/WebGPU users only.
2. **"RL" = bandit counters on rules/recipes/phrases**, not policy training. Same feedback
   signal, shippable now, explainable, and reversible.
3. **The knowledge graph starts as ontology tables on the existing registries** (capability
   index, skills, effects) — not a 15 000-node graph store. The registries already are the
   seed graph; we grow them.
4. **Fleet-scale learning ("50 000 users") is deferred** behind consent/telemetry that doesn't
   exist yet. Per-user, on-device learning ships first with an aggregate-ready schema.

---

## Build plan

Statuses: ✅ shipped · 🚧 in progress · 🔜 next · 🧭 planned

| # | Phase | Status | What ships |
|---|-------|--------|------------|
| B0 | **Instrument first** | ✅ 2026-07-09 | Routing ledger (`ai/brain/ledger.ts`), token estimator, Insights "Brain routing" block, eval harness. Measure before optimizing. |
| B1 | **Reflex + router skeleton** | ✅ 2026-07-09 | `ai/brain/router.ts` ahead of the planner in `AiChatPanel`; tier-0 command table; registry-generated FAQ (`ai/brain/faq.ts`); honest "⚡ Instant" labels; `brain:eval`. |
| B2 | **Command compiler** | ✅ first slice 2026-07-10 | Tier-1 grammar (`ai/brain/rules.ts`): text-color / move-in-time / fades / blur rule families, type-gated targets, decline-don't-guess. Grow rule coverage + the eval corpus toward the full 50-prompt set. |
| B3 | **Semantic layer** | ✅ 2026-07-10 | `ai/brain/semantic.ts`: slot extraction (targets/times/colors/numbers) → intent skeletons; curated phrase index (exact match free, lazy-MiniLM embeddings for near-paraphrases, threshold 0.9 + margin 0.04); matches select INTENT only — the rewrite re-enters tiers 0/1 so every structural/type/Zod gate still applies. Plan cache: normalized prompt + exact composition signature → free replay (undo-then-repeat). Async in the panel; escalates instantly while the model is cold. |
| B4 | **Model classes** | ✅ 2026-07-10 | Gateway `fast` pool (llama-8b-instant / flash-lite class; own cooldowns, 8 s timeout, temp 0, 900-token cap); `POST /ai/plan/fast`; `ai/brain/fast.ts` tier-3: `looksTransactional` economic gate → micro context (target clip only + compact action catalog ≈300 tokens) → JSON steps or `escalate`, every step re-validated via Zod. Honest "⚡ Fast lane" label; ledger route `llm-fast`; 👎-gated as `t3.fast-lane`. |
| B5 | **Loop economy v2** | ✅ core 2026-07-10 | Final-batch contract (`"final": true` + `finalSummary` → all-steps-success ends the run with NO closing LLM call); slice diffs after iteration 1 (added/changed layers full, unchanged as ref+id stubs); capability-gap pre-check ("keyframe the blur amount" → instant honest answer + alternatives; keyframeable properties still pass through). Ahead: MotionIntent/TextLookIntent compilers (generalizing GradeIntent — own build slice, renderer-parity rules apply). |
| B6 | **Learning loop** | ✅ 2026-07-10 | 👍/👎 feedback row + per-rule trust gate (`ai/brain/feedback.ts`); implicit signals (undo-a-brain-edit-within-60 s = reject; moving on to a new prompt with edits standing = weak confirm); learned-phrase WRITE path (`maybeLearnPhrase`: a single-action LLM resolution teaches the user's skeleton to tier 2 — slot-arity-gated so only generalizable phrasings are learned); aggregate-ready event feed (`drainFeedbackEvents`) for Stage-2 universal learning. Preference stats ride the existing P6/P11 memory facts. |
| B7 | **Knowledge expansion** | 🚧 first slice 2026-07-10 | Concept → recipe shipped: exact-phrase named looks ("make it cinematic" / teal & orange / noir) compile straight to the color-grade skill with a registered `CreativeLook` — deterministic, free, 👎-gated. Ongoing: more recipes, formalized tool chains, heuristics — this is the moat. |
| B8 | **Exploratory** | 🧭 | Local tiny-LLM router (Ollama/WebGPU); fleet aggregation behind consent; TTS read-back pairing for voice sessions. |
| CP1 | **Editor command plane** | ✅ v1 2026-07-11 | Second control surface next to timeline actions: `editor-commands.ts` registry (web) + EditorPage dispatcher + tier-0 rules (`ai/brain/commands.ts`) — "pan mode"/"pause"/"select clip 3"/"go to 12 seconds"/"half res"/"toggle snapping"/"redo"/"export" EXECUTE instantly (no approval — view/transport state; saying the opposite is the undo). FAQ tips for play/pan retired in favor of execution. Semantic exemplars map paraphrases ("freeze playback") to commands. `openPanel` added same day (user hit "open effects tab" escalating to the LLM): open/close/toggle Media Pool / Effects / Color / Project Settings / Inspector — "effects"/"color" need a tab/panel suffix (bare "show effects" stays ambiguous → escalates). Voice mode v1 (2026-07-11): AI-panel header toggle, **Alt+L** shortcut, and an opt-in **"Hey Kimera" wake word** (standby Web Speech recognizer, Ear header toggle, persisted; never contends with dictation) (+ long-press mic, + spoken "stop listening" exit) with a full-window `.voice-aurora` portal. Voice round 2 (same day): **trainable wake word** (fuzzy matcher `ai/wake-word.ts` + "were you calling me?" learning card — mishearings like "hello mia" are confirmed once and learned), **TTS read-back** (`ai/tts.ts`, voice-session-only, mic gated while speaking), **carry-through** ("hey kimera, blur clip 2" executes in one breath), **Kokoro-82M natural voice** (kokoro-js, Apache-2.0, in-browser WebGPU fp32 / WASM q8; background warm with visible download % in the chat; Web Speech = instant fallback) — cool slow edge glow while listening, warm fast sweep while executing, status pill with live transcript tail. Voice round 4 (2026-07-12): **streaming TTS** (worker speech sessions on kokoro-js `stream()` — one WAV per sentence, first sound after ONE sentence's inference, no reply length cap, 12s budget now = time-to-first-chunk), **talk mode speaks live** (completed sentences pushed while the LLM streams; SUGGESTIONS tail never spoken), **multi-point answers read in full** (`speakable()` truncation removed, line-aware bullets→sentences), **gender-matched system fallback** (Michael selected → male system voice during warm-up). Voice round 5 (2026-07-12): **accurate ears** — `transcript-normalizer.ts` (deterministic editor-lexicon vocabulary biasing on dictation finals, precision-first context gates, eval-covered: "lip one in lower be to layer" → "clip 1 in lower V2 layer") + opt-in **Moonshine-base local ASR** (`asr.worker.ts`, q8/wasm ~60MB, ⚙ "High-accuracy hearing": the recorded utterance is re-transcribed locally and replaces the Web Speech final) + **clarify dedupe in AgentLoop** (affirmatives annotated CONFIRMED; identical re-asked question auto-answered once, third ask stops the run). Voice round 6 (2026-07-12): **WebGPU Kokoro** (same q8 files, sanity-generation guard → auto WASM fallback; ⚙ shows GPU/CPU), **instant ack cache** ("Okay."/"Done."/"Yes?" pre-generated per voice), **network-voice fallback preference** (Google network voices over SAPI). v2: timeline-zoom lift, LLM-composable `editorCommand` step kind, barge-in voice, streaming Moonshine interim. |

**Expected impact (estimates, to be verified against the ledger):** replaying the
`AI_REFINEMENT.md` session, ~70 %+ of its requests resolve at 0 tokens; every tier-4 run saves
at least one LLM call (the closing iteration); trivial edits go from 6–17 s to <100 ms. The
acceptance bar for each phase is the routing ledger showing the predicted shift, not typecheck.

---

## Current state — what already exists and where it fits

The old phase tracker (1–16), mapped into the brain. Nothing shipped is lost; several pieces
turn out to be seeds of brain organs.

| Old phase | Status | Where it lives in the brain |
|---|---|---|
| 1. Editor Foundation | ✅ | The body the brain operates. `apps/web` editor. |
| 2. Tool Registry (`tools.ts`) | ✅ | Knowledge layer substrate. |
| 3. Effects Registry (+ color system 🚧, see [`COLOR_SYSTEM_PLAN.md`](COLOR_SYSTEM_PLAN.md)) | ✅ | Knowledge layer substrate; GradeIntent is the intent-DSL template (tier 4). |
| 4. Timeline Action Registry | ✅ | The execution engine every tier compiles into. The only mutation path. |
| 5. Capability Index + grammar | ✅ | Seed of the ontology; `describeCapability` powers `inspect` and the FAQ. |
| 6. Planning Engine (LLM + deterministic floor) | ✅ | LLM planner → tiers 3/4. Deterministic planner → tier-1 corpus + demoted offline fallback (honest labeling shipped 2026-07-08). |
| 7. Execution Engine + undo | ✅ | Unchanged; also the learning loop's reward source (undo = negative signal). |
| 8. Conversation Layer | ✅ | The transcript UI (Claude-Code-style agent transcript, shipped 2026-07-09) renders every tier's work with honest route labels. |
| 9. Planner accuracy hardening | ✅ (batch done) | Its 50-prompt ledger becomes the `brain:eval` acceptance corpus — see Appendix A. |
| 10. Intent Continuity | ✅ | Seed of the router's focus state. |
| 11. Memory OS (Creator+Project) | 🚧 | The learning loop's storage substrate (MemoryFact local-first + sync). |
| 12. Reference-driven editing (image input ✅) | 🚧 | Tier-4 concern; style fingerprints later feed the knowledge layer. |
| 13. Tool Registry Expansion | 🧭 | Knowledge layer growth (B7) — AI can only do what exists. |
| 14. Agentic loop | ✅ (shipped 2026-07-09) | Tier 4 itself: `AgentLoop.ts`, iteration caps, inspect steps, action log, loop-breaker. B5 upgrades it. |
| 15. Memory Panel UI + trust | ✅ | Trust surface; will also expose learned phrases/preferences (B6) with Edit/Forget. |
| 16. AI Cost & Scaling | superseded | This document *is* the cost plan: the cascade replaces "pay per request" with "route around the LLM". BYO / deterministic-floor / degrade-notice work stays shipped. |

Voice (dictation, hands-free sessions, spoken approvals) and beat detection (real DSP →
markers/cuts) shipped 2026-07-09 and sit on top of the cascade unchanged — voice is an input
method; the router is input-agnostic.

---

## AI safety (always, tier-independent)

AI must never, without confirmation: delete user content, overwrite/replace media, run
destructive actions automatically, or export. A malformed/empty model reply must **never**
fall through to a destructive guess (clarify salvage + the media-clip delete guard, Phase 9).
**Brain addendum:** fast paths obey the same gates — a tier-0/1 compiled plan flows through
the identical mode pipeline (Professional approval bar, destructive-action clarify guards);
only structurally exact commands may fast-path at all, and a fast path with a nonzero
wrong-fire rate in eval does not ship.

---

## Appendix A — 50-prompt acceptance ledger (Phase 9 pass, preserved)

Now the seed of the `brain:eval` corpus. ✅ pass · ❌ fail · 🆕 fixed that batch · 🔜/🧭 deferred.

| # | Prompt | Before | Now |
|---|--------|--------|-----|
| Shapes | add red circle / neutral orange shape / blue box top / small black square center / green rect bottom-right / `#ff00aa` pill | ✅ | ✅ |
| 6 | vertical `#ff00aa` pill | ❌ added horizontal | 🆕 orientation in `resolveShapeGeometry` (re-test) |
| 7–8 | big / tiny yellow circle | ❌ pill, no size | 🆕 geometry authoritative + size scale (re-test) |
| 9–13 | add text / WARNING / bottom-center / large white SUBSCRIBE | ✅ | ✅ |
| 10 / 10.1 | bold red SALE / italic SALE | ❌ no bold/italic | 🆕 bold/italic params + detection |
| 12 / 15 | "50% OFF" top-left / "hello" bottom | ❌ off-frame | 🆕 safe-area clamp |
| 14 | caption label LIVE | ❌ | 🧭 caption-label styling |
| 16–22 | bigger / smaller / recolor / dramatic / rename / huge | ✅ | ✅ |
| 16b | put selected text to center | ❌ | 🆕 `updateText` x/y move |
| 23–26 | captions / subtitles / transcribe / usual style | ✅ | ✅ |
| 27–28,30 | remove/cut background | ❌ runner not registered | 🧭 tool expansion |
| 29 | remove the person | ⚠️ immature tool | 🧭 tool expansion |
| 31 | remove the blur | ❌ couldn't remove | 🆕 `removeEffect` by type |
| 32–35 | cinematic / color grade / moody / subtle blur | ⚠️ shallow | 🚧 color system + recipes |
| 36–37 | track + follow text | ✅ (⚠️ forces extract first) | 🔜 selectable sub-steps |
| 38 | fade in | ✅ | ✅ |
| 39 | fade out | ❌ removed fade-in | 🆕 additive fades |
| 40 | fade in **and** fade out | ❌ only one | 🆕 additive fades |
| 41 | start two seconds later | ❌ asked to clarify | 🔜 start-time intent |
| 42 | delay selected layer 3s | ✅ | ✅ |
| 43 | delete this layer | ❌ nuked the clip | 🆕 media-clip clarify guard |
| 44 | remove selected layer | ✅ | ✅ |
| 45 | delete the text | ✅ | ✅ |
| 46–48 | compound (captions+cinematic / circle+fade / bold text+blur) | ⚠️ untested | 🔜 verify |
| 49–50 | "make it pop" / "do something cool" | should clarify | ✅ clarify |

## Appendix B — Cost & scaling notes (from old Phase 16, still true)

Shared free-tier provider keys are rate-limited per *account*, not per user — a real userbase
trips 429/503 fast. Shared free keys are demo convenience, not production capacity. Real
capacity = **the cascade** (most requests never reach a model) + **BYO keys** (user's own
quota; zero owner cost) + the **deterministic offline floor** (always available) + eventually
paid pooled keys behind auth/quotas/credits — the last piece stays 🧭 while the
`CLAUDE.md` no-enforcement rule holds (pricing/credits are metadata only; no gating).
