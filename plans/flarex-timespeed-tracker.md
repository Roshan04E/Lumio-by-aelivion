# TimeSpeed and Tracker — design note before code

- Status: **proposal, awaiting review.** No code written.
- Date: 2026-07-28
- Governing: ADR-007 (parity by construction), ADR-008 (materialization substrate),
  ADR-009 (completeness rules R1–R3), **ADR-010 (node capability contract)**

The evaluation engine is frozen. The only question this note has to answer for each node is the one
reviews ask: **does this satisfy ADR-010?** ADR-010's own test for that is sharp — a node needs no ADR
change if it answers *only* the existing closed questions, and the *only* thing that reopens it is a
genuinely new evaluator **question**.

The two nodes land on opposite sides of that line, which is why they are written up together.

---

## 1. Tracker — satisfies ADR-010 as it stands. Buildable now.

ADR-010 §4 already lists `TrackingData` as an ArtifactKind and names `tracker` among the node types
the evaluator must know nothing about. Nothing here is new; the contract anticipated it.

**Scope for v1: consume, do not analyse.** The repo already produces tracking data —
`TrackingPathArtifactData` (`packages/shared/src/masks.ts`) with `points`, `smoothing`, `is3d`,
produced today by the person-extraction path. A Tracker node that *reads* that artifact and exposes it
to downstream nodes is a wiring exercise. A node that *computes* a new track is a tracking algorithm,
which is a different project with a different risk profile. Ship the first; the second is what "make
our trackers advanced" means later, and it slots into the same declaration.

**Declarations (all existing questions):**

| Question | Answer | Why |
|---|---|---|
| `ArtifactKind` | `TrackingData` | Already in the ADR-010 registry |
| `resourceClass()` | RAM | Point lists, not textures |
| `executor()` | CPU / Worker | No GPU work in v1 — it reads an artifact |
| dependencies | `source` (the artifact), `params` (smoothing), `time` | R2: all of them, nothing hidden |
| `requiresMaterialization()` | `true` | It yields an artifact, not a fold over pixels |
| `schedulingMode()` | `sync` for v1 | Reading a resident artifact is cheap; a real analyser becomes `async` |
| `isStateful()` | `false` | v1 reads; it does not accumulate |
| `EvaluationEstimate` | low/low/low | Relative and unitless per ADR-010 §3 |

**Parity (ADR-007).** Because v1 only reads artifact data that already travels in the manifest, preview
and Remotion consume identical bytes. This is parity by construction rather than by testing, which is
the standard ADR-007 sets.

**When a real analyser lands**, it declares `stateful` + a seek contract and moves to the temporal lane
(§7), re-entering content-addressing through explicit **baking** — which is exactly what
`TrackingPathArtifactData` already is. The v1 node becomes the consumer of the baked result and does
not change.

**Open question for review:** should the node take the artifact by id (explicit, matches
`sourceAssetId` today) or by an `auxInput` edge from a future analyser node? The second is where this
ends up; the first is buildable now. I lean explicit-id for v1 and an edge later, since an edge to a
node that does not exist is a shape we cannot test.

---

## 2. TimeSpeed — does **not** satisfy ADR-010 in the general case

**The problem.** TimeSpeed does not *read* time. It **rewrites the time its upstream subtree is
evaluated at**. Check that against the closed question set in ADR-010 §5:

| Registry | Questions |
|---|---|
| Dependency | `versionToken()`, `scope()` |
| Capability | `requiresMaterialization()`, `EvaluationEstimate`, `isStateful()`, `schedulingMode()`, `backendPreference()` |
| ArtifactKind | `resourceClass()`, `executor()` |

None of these lets a node say *"evaluate my inputs at a different t."* That is a new evaluator
question — a new **decision**, not a new answer. By ADR-010's own rule that is precisely, and only,
what reopens the ADR.

It is worth being exact about why this is not merely a dependency. Under R1 the hash folds *the
resolved value at time t*, and under R3 it folds *resolved upstream content hashes*. Both are
well-defined once you know which `t` the subtree was evaluated at. A retime node changes that `t` for
everything above it, so it is not contributing a token — it is altering the question every upstream
node is asked. Dependencies fold into the hash; this changes what gets folded.

### Three ways forward

**A. Reopen ADR-010 with one new question: `inputContextTransform()`.**
Honest and complete. A node may transform the evaluation context handed to its inputs; the evaluator
composes transforms down the traversal, and the transformed `t` participates in the hash exactly as
today. Retiming, and every future context-warping node, then works generally.
*Cost:* an ADR reopen, which ADR-010 deliberately makes "rare, deliberate, visible". It should be
rare — but this is a genuine new decision, which is the case the escape hatch exists for.

**B. Declare it `stateful` and run it in the temporal lane.**
Rejected. Retiming is *pure* — same input, same `t`, same output. Declaring it stateful to obtain
sequential evaluation would forfeit content-addressing for a node that deserves it, and would be a lie
in the declaration. ADR-010 §2 makes determinism a law; §7's lane is for feedback and accumulators.
Using it as a general-purpose escape hatch is how a frozen contract rots.

**C. Lower it at compile time, scoped to source sampling. — recommended for now.**
The compiler already threads time into source draws; the timeline's own speed/ramp does exactly this
(`getLayerSpeed`, `rampTangent`, `mapSourceTime`). A `TimeSpeed` that retimes **the source time of
MediaIn nodes in its subtree** needs no new evaluator question at all: it is a lowering-time rewrite of
the same kind as the merge-group lowering, and the evaluator never sees it.

*What C buys:* the common case — "play this clip at 50%" — which is what a user reaching for TimeSpeed
almost always means.
*What C cannot do:* retime a subtree containing computation whose result varies with time other than
through a source sample — an animated parameter, a generator, a future tracker. Those need the whole
subtree re-evaluated at `t'`, which is option A.
*The trap to avoid:* shipping C and letting people believe they have A. If C ships, the node must be
**named and documented for what it is** (source retime), and the inspector must say so. A node that
silently ignores animated upstream parameters is worse than no node.

### Recommendation

Ship **C** now, with the limitation stated in the UI, and treat **A** as the trigger for the first
deliberate ADR-010 reopen when a real case demands it. Do not ship B.

I want a decision on this before writing code, because C and A have different node names, different
inspector copy, and different socket shapes — C is not a subset of A that can be quietly widened
later, and pretending otherwise is how the merge-blend bug happened (two constructs sharing a lowering
shape do not share its semantics, v32i).

---

## What I am NOT proposing

- No change to the evaluator for Tracker. It declares and nothing else.
- No new ArtifactKind. `TrackingData` already exists in the registry.
- No tracking algorithm in v1.
- No ADR edit without an explicit decision on §2 above.
