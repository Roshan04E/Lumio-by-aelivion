# Orreris OS — The Creative Operating System

> **What this file is:** the decade-scale architectural north star for Orreris's intelligence
> platform — how every future intelligence capability (local rules, LLMs, perception, plugins,
> marketplace extensions, automation, collaborative AI) fits into one coherent operating
> system. It is a **direction document, not a build plan**: it constrains shape, records
> settled decisions, and defines invariants.
>
> **Relationship to sibling docs (don't duplicate):**
> - [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) — *how today's AI routing works* (the tiered
>   brain, B0–B8, CP1). It keeps shipping independently; this doc never overrides its
>   invariants — it extends them upward.
> - [`architecture.md`](architecture.md) — shipped/deferred product log.
> - `project-tracker/` — append-only problem/solution logs.
>
> **Status:** v1, 2026-07-18. Nothing in this doc is shipped as described here; the
> [Existing seeds](#existing-seeds--what-already-exists-and-what-it-becomes) section maps
> which shipped systems already embody which concepts.

---

## Thesis

Orreris is **a professional editor with an intelligence operating system on top** — never an
"AI video generator." The editor is fully usable without AI; intelligence *operates the
editor's tools* through one narrow, validated, undoable interface.

The strategic reframing this document exists to record:

> **The architecture diagram is copyable. What compounds and cannot be copied is the data
> the architecture accumulates:** the recipe/ontology corpus, the eval corpora, per-user
> learned phrases and parameter preferences, the perception fact stores, and the
> deterministic **craft compilers** where real colorist/editor knowledge is encoded.
> The architecture's only job is to be the vessel that makes that data accumulate
> automatically, per user and per project, forever.

So priorities follow from the moat, not the diagram: grow compilers and corpora first,
boxes second.

The mental model every layer must obey:

> **The LLM never edits. Recipes never execute. Primitives never reason. Engines never
> guess. Timeline operations are the only thing that mutates the project.**

---

## The OS mapping

The operating-system metaphor is load-bearing, not rhetorical — it unifies the golden rules
in one picture and names the missing subsystems:

| OS concept | Orreris equivalent |
|---|---|
| **Syscall interface** | **Timeline Action Registry** — the ONLY mutation path, Zod-validated, undoable (already law) |
| User programs | Blueprints — validated, sandboxed above the syscall line |
| Kernel | Cognitive Runtime (planner, hypothesis engine, cost gates) |
| Filesystem / memory hierarchy | World Model fact store, cache tiers L0–L4 |
| Scheduler | Perception scheduler + agent-loop iteration/cost budgets |
| Drivers | Observers + tool adapters (`mock`/`browser`/`cloud`/`desktop` — exists today) |
| Permissions | Safety gates: Professional approval, destructive-action guards, mode gating |
| Kernel never guesses | Precision-first: decline silently, escalate, or clarify — never guess |

No matter how sophisticated the cognitive layers become, **everything crosses one narrow,
Zod-validated, undoable syscall boundary**. That is why the whole system stays auditable.

---

## The master cascade

```
                              USER (chat / voice / UI / macro / plugin / API)
                                          │
                                   INTENT COMPILER
                    (tiers 0–2 = the parser; LLM = ambiguity resolver only;
                     ambiguity is an AST node → clarify, never guess)
                                          │
                                     Intent AST
                                          │
────────────────────────────── COGNITIVE RUNTIME ──────────────────────────────
   Planner (staged pipeline: normalize → hypothesize → query world → resolve
            recipes → expand capabilities → validate → cost-gate → blueprint)
        │                    ▲                          ▲
        │              WORLD MODEL ◄──────────── PERCEPTION SCHEDULER
        │        (typed query interface over          (pull-based observers,
        │         facts + confidence + provenance      fidelity ladder, idle
        │         + invalidation; access-path          speculation, budgets)
        │         planner underneath)
        │                    ▲
        │             LEARNING ENGINE
        │        (bandit stats on rules/recipes/phrases — B6, unchanged)
        ▼
                  BLUEPRINT IR  (dialect-based, capability-closed,
                                 Zod-validated, serializable, replayable)
────────────────────────────── EXECUTION RUNTIME ──────────────────────────────
   Recipe resolver → craft compilers (GradeIntent, MotionIntent, …)
        → Timeline Action Registry (the ONLY mutation path — unchanged)
────────────────────────────────────────────────────────────────────────────────
                     Editor Engine / GPU compositor / renderers
              (never touched by AI; web + Remotion parity rule holds)
```

Two brains, cleanly split:

- **Cognitive Runtime** — thinks, never edits. Consumes Intent ASTs and world facts,
  emits Blueprints. Knows nothing about how a contrast wheel works.
- **Execution Runtime** — edits, never reasons. Consumes Blueprints, compiles them
  through recipes and craft compilers into registry actions. Knows nothing about why.

The seam between them is the **Blueprint IR** — and because both sides validate against the
same live capability registries, nothing abstract can escape into execution.

---

## Layer 1 — Intent Compiler

Every input surface — chat, voice, UI gesture macros, shortcuts, plugins, future API —
compiles into the same **Intent AST**. The LLM is one *parser backend* among several, used
only when language is genuinely ambiguous; tiers 0–2 of the existing brain ARE the fast
parser and already emit proto-ASTs (semantic-layer intent skeletons).

```
"Move clip 3 five seconds earlier and blur it."
        │
        ▼
Intent AST
 ├── Action: Move      Target: Clip3(resolved)   Time: -5s
 └── Action: ApplyLook Look: Blur                Target: ←same (continuity)
```

Design rules:

- **Ambiguity is a first-class AST node**, not an error. An unresolved target or an
  under-specified goal compiles to `Ambiguous{candidates, question}` — downstream layers
  decide whether cheap facts resolve it or the user must (see the clarify rule, Layer 3).
- The AST is **retrofit, not big-bang**: define the IR, make tiers 0–2 emit it, keep
  `brain:eval` green throughout. The cascade's routing behavior does not change.
- Every producer (rule, embedding match, LLM, voice, macro, plugin) emits the same AST —
  which is what makes the input layer infinitely extensible without touching the kernel.

---

## Layer 2 — The World Model

The single largest addition over today's brain. The current system knows the *timeline*
deeply and the *footage* almost not at all; the World Model closes that gap — and unifies
every other queryable state behind one interface.

### One facade, five branches

```
                         WORLD MODEL
                              │
   ┌──────────┬───────────────┼───────────────┬──────────────┐
   │          │               │               │              │
Project    Editor State   Knowledge       User State    System State
(assets,   (composition   (perception     (preferences, (GPU tier,
 brand,     slice, focus   facts,          learned       capabilities.ts
 timeline)  state, mode)   inferences)     phrases, B6)  feature detect)
   └──────────┴───────────────┼───────────────┴──────────────┘
                              │
                     TYPED QUERY INTERFACE
                              │
                      Cognitive Runtime
```

Day-one honesty: the World Model is a **query facade over stores that already exist**
(composition slice, focus state, memory facts, `capabilities.ts`) plus one new subsystem —
the perception fact store. It ships as tables and registries, not a graph database.
A graph store is adopted only when tables demonstrably hurt.

### The load-bearing rule

> **The World Model answers typed queries. The planner decides what's relevant — via
> hypotheses.**
>
> The model may be *smart about acquisition* (access paths, caching, invalidation,
> speculation) and must be *dumb about meaning*. "Give me everything relevant" is not a
> query — relevance pushed into the data layer builds a second, hidden, un-evalable
> planner, which is exactly the black box this architecture exists to eliminate.

### Facts, queries, and access paths (kept distinct on purpose)

```ts
FactQuery   { type, target, budget, minConfidence }

AccessPath  { observerId, estCost, estLatency, estConfidence }   // registry data

Fact        { value, confidence, freshness, version,
              provenance:   { observerId, observerVersion,
                              inputContentHash, sampledRanges },
              dependencies: [factId] }                            // for derived facts
```

**Cost and latency live on the access path, never on the fact.** A fact is a cached value;
cost describes how you *could* acquire or refresh it, and one query may have four routes
(cached / lite observer / heavy observer / cloud plugin). The Knowledge Service underneath
the query interface is a **database query planner choosing access paths**:

```
Query: FaceCount(clip17), budget: 50ms, minConfidence: 0.9
        │
        ▼
   Access-path planner
        │
   ┌────┴─────────────────────────────┐
   │  cached fact        0ms   0.95   │
   │  FaceDetector-lite  40ms  0.95   │
   │  FaceDetector-v3    4s    0.998  │
   │  cloud observer     ~2s   0.999  │  ← plugin, future
   └────┬─────────────────────────────┘
        ▼
   cheapest path satisfying (budget, minConfidence)
```

Nothing above the query interface knows or cares which path answered. That abstraction is
what lets observers, plugins, and cloud services slot in later without touching the kernel.

One vocabulary, deliberately: there is no separate "Observable" type. An observation is a
fact whose provenance is fully retained; derived facts reference their sources through
`dependencies`. One store, one schema, one invalidation mechanism.

### Truth maintenance (the part naive knowledge graphs skip)

Footage knowledge goes stale: clips get trimmed, regraded, replaced; proxies swap in.
A graph that confidently reports last week's histogram is worse than no graph.

- Every fact is keyed by **input content hash + observer version**.
- A hash mismatch invalidates the fact and **cascades through `dependencies`** — derived
  meanings die with their inputs.
- This is the plan-cache-v2 law ("replay only while every referenced clip is
  byte-identical") promoted to the law of the entire knowledge layer.

### Confidence algebra

Inferred facts compound uncertainty (`speech ∧ one-face ∧ static-camera → interview`).
Confidence propagates explicitly through derivation; a low-confidence inference is a
**clarify trigger, not a silent steer**. "This looks like a wedding — grade it warm rather
than horror-moody?" beats a confidently wrong recipe. Precision-first extends upward: the
brain's decline-below-near-certainty rule applies to inference exactly as it applies to
tier-1 rules.

### Pull-based perception — the fidelity ladder

Perception is **memoized queries, not a batch import pipeline**. A 20-minute 4K clip ×
twelve analyzers at import would die in the browser (and fight playback for decode
bandwidth). Import runs only the near-free tier; everything else is demand-driven, with
idle-time speculation:

```
L0  free       metadata, duration, codec, thumbnails         → at import
L1  cheap      waveform, scene cuts, histogram samples       → at import / first view
L2  moderate   transcript, face presence, motion class       → on demand or idle
L3  expensive  object/entity tracking, composition analysis  → only when a plan needs it
L4  inferred   "interview", "wedding", "hopeful moment"      → derived, confidence-gated,
                                                               invalidated with its inputs
```

The perception scheduler runs observers at the **cheapest sufficient fidelity** (3 sampled
frames before a full scan), prioritized user-blocking > idle > speculative, suspended
during playback exactly like proxy builds are today. Observers are plugins from day one:
`registerObserver()` — each knows ONE thing, each is eval-covered, each declares its access
paths.

---

## Layer 3 — Cognitive Runtime

### Hypothesis-driven planning

The planner **requests** knowledge; it never receives all knowledge. The mechanism that
makes pull-based perception *directed* is the hypothesis stage:

```
"Make this scene feel darker."
        │
        ▼
Hypotheses:  Color? Pacing? Music? Lighting-look? Camera?
        │
        ▼
Query world (cheap facts first):
  current grade · scene type · music present · current mood facts
        │
        ▼
Expand by expected information gain per unit cost:
  buy an expensive fact ONLY if it discriminates surviving hypotheses
        │
        ├── one hypothesis dominant  → resolve recipes → Blueprint
        └── near-tie persists and next fact is expensive
                → CLARIFY (ask the user, don't buy L3 perception to guess)
```

That last branch is the principled home for clarification: **clarify is what the planner
does when hypothesis entropy stays high and the next fact is expensive.** It replaces
heuristic clarify triggers with an economic rule.

### The planner is a staged compiler, not a monolith

```
Intent AST → normalize → resolve targets → hypothesize → query world
           → resolve recipes → expand capabilities → validate
           → estimate cost → Blueprint
```

Each stage is a few hundred lines, independently testable, independently replaceable.
Stages are registered (`registerPlanner()` slots), not hard-coded — new domains add stages,
they don't fork the pipeline.

### The LLM's place

The LLM appears in exactly two roles, both bounded:

1. **Ambiguity resolver** in the Intent Compiler (language → AST, when tiers 0–2 decline).
2. **Creative gap-filler** in tier 4, emitting compact **intents** (GradeIntent-class DSLs)
   — never parameter values, never operations.

The LLM never touches contrast, curves, positions, or timing. It says *moody*; the color
engine — hundreds of deterministic rules consulting the World Model (histogram already
dark → keep exposure; faces present → protect skin; footage already cold → don't cool
further) — computes the wheel movements. **AI decides WHAT. Engineering decides HOW.**

---

## Layer 4 — Blueprint IR

The seam between the two brains: a serializable, validated, capability-closed intermediate
representation of *what should happen*, with zero knowledge of *how*.

### Capability closure — the golden rule, extended upward

> Actions are registry-validated. **Blueprints are registry-validated too.**
> Nothing abstract escapes into execution.

The blueprint vocabulary is **generated from** the live capability/recipe registries
(exactly like the registry-generated FAQ). A blueprint referencing an unfulfillable goal is
a **compile error at plan time**, not a runtime shrug. This kills the classic two-brain
failure mode where the cognitive side emits poetry ("Improve Hook") the execution side
can't act on.

### Dialects, not a universal IR (MLIR, not LLVM)

A fully domain-blind IR cannot be capability-closed — closure means "validated against what
execution can do," and that is inherently domain-specific. The proven answer is MLIR's
dialect architecture: **one IR infrastructure** (structure, validation machinery,
provenance, optimization passes, serialization) with **domain dialects**:

```
Blueprint IR  =  shared infrastructure
    ├── color dialect     → closed against color capabilities
    ├── motion dialect    → closed against motion capabilities
    ├── audio dialect     → closed against audio capabilities
    ├── timeline dialect  → closed against timeline actions
    └── (future) slides / 3D / doc dialects
    │
    ▼
per-dialect lowering → craft compilers → Timeline Action Registry
```

New creative domains add a dialect; the kernel, the planner, the World Model, and the
syscall boundary never change. That is the 2032 multi-domain story without sacrificing
today's validation guarantee.

---

## Layer 5 — Execution Runtime

### Taxonomy

| Concept | Definition | Exists today as |
|---|---|---|
| **Primitive** | Atomic, deterministic, registry-validated operation or analysis. Never reasons. | Capability-index entries, timeline actions |
| **Composition (Recipe)** | Data (not prompts) composing primitives into a creative strategy. Never executes directly. | Skills registry, CreativeLook rows |
| **Craft compiler** | Deterministic engine expanding an intent/blueprint into real editable primitives, consulting the World Model. Never guesses. | `GradeIntent` compiler; MotionIntent/TextLookIntent planned |
| **Assembled agent** | A scheduled chain of compositions for a workflow ("podcast agent"). **Never hand-written** — assembled by the scheduler from registered parts. | Tool chains (beats[] → cut) are the seed |

No code renames: "skills registry" stays named what it is in code; this table is the
conceptual layer. There are **no hand-built domain agents** (no "Audio Agent" class) —
agents are assemblies, which means every new capability strengthens every workflow that can
use it, automatically.

### Everything enters through contracts — the Intelligence SDK

Whether built by us, a future teammate, or a marketplace extension, every component enters
through the same registration surface:

```
registerObserver()      registerCapability()    registerRecipe()
registerIntent()        registerPlanner()       registerValidator()
registerInference()     registerContextProvider()
```

The runtime never knows what "Moody" means or how face detection works. It only knows how
to **discover, compose, validate, schedule, and execute** registered components. Plugin
marketplace, collaborative AI, and automation are the same mechanism at different trust
levels (permissions apply per the OS mapping).

---

## Explainability — a product surface, and half the moat

Because every layer is deterministic data, the full decision trace is serializable:

```
Intent AST → hypotheses considered → facts consulted (with confidence & provenance)
           → recipe chosen → blueprint → operations applied
```

Ship it as UI. *"Why did you do this?"* →
*"Detected faces (0.97) → protected skin · histogram already dark → kept exposure ·
project inferred wedding (0.91) → warm-moody variant."*

No LLM-first competitor can produce that honestly, because their model *is* the black box.
This is the existing honest-labels principle ("⚡ Instant · local" vs model name) grown into
a differentiator. It also makes every result **replayable**: blueprint + world-state
snapshot reproduces the edit deterministically — which doubles as the regression harness.

---

## Invariants (tier-independent, non-negotiable)

1. **Registry-only mutation.** All edits cross the Timeline Action Registry syscall
   boundary. Blueprints are additionally capability-closed at plan time.
2. **Precision-first everywhere.** Rules, inferences, hypotheses: decline silently,
   escalate, or clarify. A fast path (or inference) that is sometimes wrong is worse than
   none. Wrong-fire count in eval must be zero to ship.
3. **The renderer is never touched by AI work.** Craft compilers emit timeline data
   consumed identically by web preview and Remotion (parity rule; `render:compare:pixels`).
4. **Honest labels.** Every result says how it was produced; traces are inspectable.
5. **Eval-gated shipping.** `brain:eval` grows to cover blueprints (intent → expected
   blueprint corpora) and perception (golden fact sets per observer). An observer, rule, or
   recipe that fails eval doesn't ship.
6. **Tables first.** Every subsystem ships as registries/tables on existing stores before
   any dedicated infrastructure (graph DBs, trained models) is considered.
7. **Local-first.** Facts, learning, and preferences live on-device (OPFS/local stores)
   with the existing sync contracts; fleet aggregation stays behind consent.
8. **Safety gates are layer-independent** — destructive-action guards, Professional
   approval, and mode gating apply identically no matter which layer produced the plan.
9. **No enforcement of pricing/credits** (metadata only) while the CLAUDE.md rule holds.

---

## Existing seeds — what already exists and what it becomes

| Orreris OS concept | Existing seed (shipped) |
|---|---|
| Intent Compiler / Intent AST | Brain tiers 0–2; `semantic.ts` intent skeletons; `clip-reference.ts` |
| Blueprint IR + craft compilers | `GradeIntent` → deterministic grade compiler (the proven template) |
| World Model: Editor State | Composition slice, focus state, `intent-continuity.ts` |
| World Model: User State | B6 memory facts, learned phrases, preference stats |
| World Model: System State | `capabilities.ts` feature detection |
| World Model: truth maintenance | Plan-cache v2 byte-identical invalidation rule |
| Access-path planner | Tool adapter selection (`tool-runner.ts` mock/browser/cloud) |
| Perception observers | `local-transcription.ts` (the reference browser-ML pattern), beat detection |
| Capability graph | `capability-index.ts` + tools/skills/effects registries |
| Compositions / recipes | Skills registry, CreativeLook concept→recipe (B7) |
| Assembled agents | Tool chains (beats[] → markers/cuts) |
| Learning engine | B6 bandit feedback, 👍/👎, undo-within-60s |
| Cost gates | The cascade itself; `looksTransactional`; context compiler budgets |
| Eval harness | `brain:eval`, 50-prompt ledger, routing ledger (B0) |
| Syscall boundary | Timeline Action Registry (unchanged, forever) |

Orreris OS is a **promotion of shipped seeds into first-class contracts** — not a rewrite.
The second-system trap is the failure mode to guard against: any phase that requires
pausing AI_ARCHITECTURE.md's shipping cadence is mis-scoped.

---

## Build direction (order, not schedule)

1. **K1 — Fact store + provenance/invalidation + perception scheduler.** The genuinely new
   layer; unblocks everything. Ships with THREE observers (histogram, transcript-derived,
   face presence — two reuse existing code), each eval-covered. Observer count grows
   forever after; the scheduler does not.
   **✅ first slice shipped 2026-07-18** — `apps/web/src/ai/world/`: typed contracts
   (`types.ts`), in-memory fact store with provenance + dependency-cascade invalidation
   (`fact-store.ts`), observer registry (`observers.ts`), perception scheduler riding the
   editor's background gate (`scheduler.ts`), Knowledge Service query planner choosing
   cached → cheapest sufficient access path (`knowledge.ts`), three observers (L0 metadata,
   L1 sampled-frame look/histogram, L2 composition text summary), and the first brain
   consumer — an async local "world" tier ("analyze clip 3" / "analyze the timeline")
   answering from measured facts with honest provenance, wired into AiChatPanel between
   tier 2 and the fast lane, ledger route `world`. Acceptance: `world:eval` (26 checks —
   memoization, truth maintenance, cascade, path planning, decline, route precision);
   `brain:eval` unchanged-green. Face-presence observer + K2 persistence still open.
2. **K2 — World Model query facade** over existing stores + the fact store; typed
   `FactQuery` interface; access-path registry.
   **✅ first slice shipped 2026-07-18** (typed query interface + access-path registry
   already landed with K1): fact-store **persistence** (localStorage, debounced, bounded —
   correctness-free because every read stays signature-verified; OPFS deliberately skipped
   per invariant 6), and the remaining **state branches** behind the same `FactQuery`
   interface — `system:browser` (capabilities/hardware via tools/capabilities.ts),
   `user:local` (B6 rule-trust + routing-ledger introspection via new
   `listRuleStats()`), `project:current` (media-bin summary). Route consumers:
   "analyze my system" / "analyze the project" / "show my ai usage". Editor state
   deliberately stays in BrainContext (ephemeral + free to read — nothing to amortize).
   Acceptance: `world:eval` grown to 40 checks (state branches, feedback-driven
   auto-invalidation, persistence reload round-trip, widened must-escalate corpus).
3. **K3 — Blueprint IR** (infrastructure + first dialect: color) + capability-closure
   validation. Formalizes what GradeIntent proved; MotionIntent/TextLookIntent become the
   second and third dialect payloads.
   **✅ first slice shipped 2026-07-18** — `packages/shared/src/blueprint/`: dialect
   registry + `Blueprint`/`BlueprintGoal` types + the `closeBlueprint` closure driver
   (all-or-nothing: any unfulfillable goal fails compilation with the full issue list),
   where **closure computes the lowering** — proving fulfillability IS producing the
   actions, so emptiness is unrepresentable downstream. First dialect: **color**
   (payload = the shipped GradeIntent schema/compiler) with look canonicalization against
   the LIVE creative-look registry (exact → case/format-insensitive → colorist alias
   table, every rewrite recorded as an honest repair note) and `empty-goal` /
   `unknown-capability` compile errors carrying the look library as suggestions. The
   panel's grade skill executor now runs through `closeColorGrade` — killing the founding
   regression ("make it moody" → `look:"Moody"` → silent "Applied 0"; now it repairs to
   Noir @ 55% with the repair shown, and a truly unknown look answers with the library
   list). Same-day follow-up: the same closure applied at the ACTION seam —
   `resolveLookName` lives in color/looks.ts as the one shared resolution; `look`-type
   effect params are validated (unknown → rejected with the library) and canonicalized at
   `addEffect`/`updateEffect` write time, closing the second path (LLM-emitted raw
   creativeLook steps with lowercased names stored verbatim → renderer no-op).
   Acceptance: `blueprint:eval` (24 checks). Open: motion/text dialects, target
   binding contract formalization, K4 planner emitting multi-goal blueprints.
   **Motion dialect shipped 2026-07-18** — `motion/motion-intent.ts` (MotionIntent schema,
   per-kind style vocabulary + aliases, deterministic keyframe compiler that settles on the
   layer's OWN base transform; exits via time-axis mirroring, no value bookkeeping) +
   `applyMotion` registry action (ONE undoable step expanding to ordinary layer keyframes —
   renderer parity free via the shared animation evaluator; unknown styles fail validation
   with the vocabulary; aliases repair at the write seam) + `blueprint/motion.ts` dialect.
   Multi-domain blueprints (color + motion) now close end to end — the K4 planner has two
   domains to compose. `blueprint:eval` → 41 checks. Open: text dialect, K4.
   **Text dialect shipped 2026-07-18 — all three K3 dialects closed.** `text/text-look.ts`
   (7 built-in text looks — Headline, Subtitle, Caption Pill, Lower Third, Neon, Outline,
   Minimal — as plain TextStyleFields data; `resolveTextLookName` is the ONE shared
   resolution: exact → case/format-insensitive → alias table title→Headline, glow→Neon,
   nameplate→Lower Third…) + `applyTextLook` registry action (bakes a look via
   `applyTextStyle` in one undoable step; text layers only; unknown names fail validation
   carrying the library; aliases repair at the write seam) + `blueprint/text.ts` dialect
   (closure canonicalizes, lowers to one applyTextLook template). The tier-0 APPLY-LOOK
   reflex falls through color → text: "apply the neon look" on a text clip compiles
   instantly at tier 0; on a video clip it answers honestly ("Neon is a text look —
   select a text clip"); unknown looks answer with BOTH libraries. brain:eval +3 corpus
   rows. Open: target binding contract formalization → K4.
4. **K4 — Hypothesis stage in the planner** with budgeted expansion and the
   entropy-clarify rule; planner refactored into registered stages.
   **✅ first slice shipped 2026-07-18** — `packages/shared/src/blueprint/hypothesis.ts`
   (the staged pipeline: normalize → hypothesize → query the World Model → expand by
   information-gain-per-cost → resolve the mood recipe → emit a multi-goal Blueprint →
   `closeBlueprint`, all-or-nothing) + `apps/web/src/ai/world/hypothesis-route.ts` (the
   brain-tier wiring after the K1 world tier). Mood recipes are DATA
   (`registerMoodRecipe`: moody / dramatic / cinematic + tight aliases); two hypotheses per
   vibe ask (grade-the-picture vs restyle-the-titles) start as a deliberate prior near-tie,
   so evidence must be BOUGHT: the cheap composition-text fact discriminates (incidental
   captions concede to the grade; a text-dominant timeline wins outright for the title
   treatment; the middle band stays tied), and the expensive media-look fact is bought only
   to SHAPE a winning grade (footage already measured dark → gentler intensity, honestly
   noted). **The economic clarify rule is live**: a persisting near-tie with no affordable
   discriminating fact left returns a clarify whose two suggested follow-ups are tier-0
   APPLY-LOOK phrasings — either answer then resolves locally for free. "make it moody" /
   "make this feel dramatic" now produce a color(+motion)(+text) blueprint closed
   atomically, bound to real layers, executed through the ordinary plan pipeline with the
   full explainability trace (hypotheses, facts consulted with access paths, repairs) in
   the plan notes. Precision-first: unknown mood words ("faster") escalate silently.
   Acceptance: `blueprint:eval` grown by 20 checks (dominance short-circuit, economic
   clarify never buying the shape fact, dark-footage shaping, atomic 3-dialect close,
   route binding, whole-string discipline). Open: registered-stage refactor of the
   planner proper, clarify answers resuming conversationally, more moods/observers (K5).
5. **K5 — Scale the data**: recipes, observers, inference rules, blueprint eval corpora,
   explainability trace UI, SDK surface for plugins.
   **✅ first slice shipped 2026-07-18** — (a) **The decision trace as a product surface**:
   `ai/decision-trace.ts` records one serializable DecisionTrace at every apply/answer seam
   (intent → route/rule/provider → provenance notes carrying K4 facts-consulted + repairs →
   operations → outcome), and the tier-0 **WHY reflex** ("why did you do that?" / "what did
   you just do" / "explain the last edit") answers from it instantly — the doc's
   "no LLM-first competitor can produce this honestly" claim made tangible: model-planned
   turns get an honest "🤖 model planned WHAT; deterministic registry actions did HOW"
   trace, local turns show the exact rule + measured facts, and a WHY answer never clobbers
   the trace it explains. (b) **Moods as registered data**: vintage (→ Faded Film,
   Caption Pill titles) and gritty (→ Bleach Bypass @ 75, shake accent, Outline titles)
   added as pure `registerMoodRecipe` rows — zero runtime changes, proving the rule of
   engagement. Acceptance: brain:eval +6 (WHY corpus incl. must-escalate guards),
   blueprint:eval +6 (data rows close end to end). Open: trace UI chrome (collapsible
   "Why?" row instead of an ask), face-presence observer, inference rules, SDK surface
   formalization.
   **Inference rules first slice + motion reflex shipped 2026-07-18 (second slice)** —
   `world/observers/character.ts`: the first L4 DERIVED fact (`composition.character`:
   caption-driven/mixed/footage-driven × fast-cut/moderate/long-take), consuming the L2
   text-summary FACT through the Knowledge Service and demonstrating the three inference
   laws: confidence propagates (rule prior × evidence, never ≥ it), dependencies cascade
   (a text edit kills the derived fact via the store's dependency graph — verified in
   world:eval), meaning stays honest (the value carries the raw shares; the world answer
   labels it "inferred · N% confidence"). Infra: per-fact `dependencies` on ObservedFact,
   and `"inline"` fact acquisition — a query issued from INSIDE a running observation runs
   the input observer directly (a nested scheduled job deadlocks the single-concurrency
   pump; world:eval caught the deadlock the day the rule was written, and now carries a
   loud-exit guard so an event-loop drain can never silently pass). Plus the tier-0
   APPLY-MOTION reflex: "pop in clip 2" / "make clip 3 slide in from the left" /
   "zoom out clip 1" / "make clip 2 pulse" compile locally to one `applyMotion` step
   (per-kind style resolution; "pop out" and deictic targets escalate; "fade in" stays a
   transition). Open (unchanged otherwise): trace UI chrome, face-presence observer, more
   inference rules, SDK formalization.

Rule of engagement: **build the runtime first, resist user-facing features until the
pipeline is stable, treat observers/recipes/capabilities as plugins from day one.** After
K3, adding "make it feel cinematic" is registering data, not modifying the runtime.

---

## Divergences — where this doc departs from the brainstorm, and why

Recorded so future-us knows each call was deliberate:

1. **Cost/latency moved off the Fact onto AccessPath.** A fact is a cached value; cost
   describes acquisition routes, and one query can have several. Merging them breaks the
   moment two observers serve one fact type.
2. **No "give me everything relevant" query.** Relevance is a planning judgment made via
   hypotheses, above the query interface, where it is testable. Relevance inside the data
   layer is a second hidden planner — the black box this architecture exists to eliminate.
3. **No separate Observable type.** An observation is a fact with retained provenance;
   derived facts link sources via `dependencies`. One schema, one store, one invalidation
   path — two parallel type systems is how ontologies rot.
4. **MLIR dialects, not a universal LLVM-style IR.** A domain-blind IR cannot be
   capability-closed; dialects give multi-domain future-proofing without giving up plan-time
   validation.
5. **Pull-based perception, not import-time analysis.** Import-time full analysis dies in
   the browser on real footage; knowledge is memoized queries with a fidelity ladder and
   idle speculation.
6. **No code renames for taxonomy** (skill → primitive etc.). The conceptual layer lives in
   this doc's taxonomy table; shipped registry names stay. Renames cost weeks and buy zero
   behavior.
7. **No hand-written domain agents.** Agents are assemblies of registered compositions;
   writing an "Audio Agent" class forks knowledge that should compound.
8. **The LLM never chooses parameter values.** It emits intents; craft compilers consulting
   the World Model compute the numbers. (Inherited from AI_ARCHITECTURE.md; restated
   because it is the single most tempting shortcut.)
9. **Hypothesis expansion is budget-gated, clarify is economic.** Hypotheses expand by
   information gain per cost; a persistent near-tie with an expensive next fact asks the
   user instead of buying perception to guess.
10. **The moat is data + compilers, not the diagram.** Priorities follow accumulation:
    corpora, recipes, craft compilers, eval sets, per-user learning — the boxes exist to
    fill them.
