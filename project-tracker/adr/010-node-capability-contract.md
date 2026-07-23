# ADR-010 — Node Capability Contract (the evaluator foundation)

- Status: Frozen
- Normative: Yes
- Date adopted: 2026-07-23

```
Depends on:
  ADR-007 (renderer parity-by-construction)
  ADR-008 (materialization substrate)

Supersedes:
  ADR-009 (sections 4-8: monolithic context, value quantization)
    - ADR-009 sections 1-3 (completeness rules) remain normative

Implemented by: Slice 2+
```

## Context

For the content-version contract (ADR-009) to stay complete forever, the evaluator must never
contain node-type-specific logic. Every node type — blur, ML matte, text, color, mask, tracker,
geometry, audio-driven, generator, nested comp, and whatever exists in 2035 — must extend the
system only by **declaring** things, never by adding an evaluator branch. This ADR is the contract
between node authors and the evaluation engine.

The design went through several drafts. The frozen version below resolves four boundary defects
found in review: (1) *dependency* and *capability* were conflated; (2) `materializes` was modeled
as node metadata when it is a property of an *evaluation*; (3) artifact *representation* was fused
with execution *backend*; (4) a *closed capability enum* contradicted "extend only by declaring."
Two further refinements landed at freeze: (5) `cost` is a relative *work description*, not a scalar;
(6) version-token monotonicity is a first-class invariant.

## Decision

**The evaluator is decision-based, not node-based.** It knows a closed set of *questions* and
nothing about blur, ML, text, color, masks, tracking, or geometry. Every node is a set of
*answers*. The whole engine is two folds (identity) and three trait lookups (behavior):

```
NodeContentHash   = fold( localDependency.versionToken()  for each declared local dep )
applicableContext = fold( sharedDependency.versionToken() for each declared shared axis )
CacheKey          = ( ContractVersion, applicableContext, NodeContentHash )   # ADR-009

materialize  = requiresMaterialization ∨ fanout>1 ∨ budget(estimate) ∨ debugOverride
schedule     = trait.schedulingMode()      # sync | async | temporal
executor     = ArtifactKind.executor()     # opaque
budgetPool   = ArtifactKind.resourceClass()
```

### 1. Two orthogonal declaration axes

A **dependency** answers *"what information does this node read?"* → folds into the hash.
A **capability** answers *"what kind of node is this?"* → folds into behavior. Nothing is both.

- **Dependency registry** (open): `params`, `inputs`, `time`, `seed`, `source`, `model`, `font`,
  `workingSpace`, `outputTransform`, `renderScale`, `rendererRevision`, … Each resolves to an
  opaque version token with a `scope()` of `local` (→ hash) or `shared` (→ context).
- **Capability / execution-trait registry** (open): `stateful` (+ seek contract),
  `requiresMaterialization` (+ reason), `EvaluationEstimate`, `schedulingMode`, `backendPreference`.

### 2. Determinism is a law, not a declaration

Nondeterminism is forbidden; all randomness is a `seed` dependency. Therefore every node is
deterministic by contract, and `deterministic` is **never declared**. `pure` is the default; only
`stateful` is declared (the exception).

### 3. Materialization is evaluation-owned

Nodes declare only an intrinsic **constraint** and a **hint**; the evaluator owns the **decision**:

- `requiresMaterialization` — intrinsic: the algorithm cannot express itself as a fold (feedback,
  temporal state buffers, passes that must sample an RTT input). A node property.
- `EvaluationEstimate { gpuWork, cpuWork, memoryFootprint }` — a **relative, unitless** work
  description (never ms, never bytes) that can never change correctness. The evaluator maps it into
  whatever budgeting model exists in that era. A wrong estimate degrades performance, never output;
  it is therefore excluded from the version hash (ADR-009 exclusion list).
- Decision: `materialize = requiresMaterialization ∨ fanout>1 ∨ budget(estimate) ∨ debugOverride`.

There is no `materializes` capability. `stateful ⟹ requiresMaterialization`, but they are distinct
(a pure pass can require an RTT input; not all RTT-requiring passes are stateful).

### 4. Representation ≠ backend

Two independent axes, both opaque to the evaluator:

- **ArtifactKind** (representation, open registry): `Texture`, `Geometry`, `SDF`, `PointCloud`,
  `Mask`, `Vector`, `Tensor`, `Audio`, `TrackingData`, … Exposes `resourceClass()` (VRAM/RAM/… for
  per-pool budgeting) and `executor()`. Artifacts are immutable — a law, not a question.
- **Backend** (execution, open registry): `GPU`, `CPU`, `DSP`, `Worker`, `Cloud`, … A Texture may be
  CPU-produced; a Tensor may be GPU-computed. Coupling exists only as an executor-availability
  *constraint*, never as identity.

### 5. Closed evaluator interface, open registries

The evaluator is closed against a **fixed set of questions**; the set of **answerers is open**. A
trait influences the engine *only* by answering an existing question. The closed question set:

| Registry | Closed questions the evaluator may ask |
|---|---|
| Dependency trait | `versionToken()`, `scope()` → local \| shared |
| Capability / execution trait | `requiresMaterialization()`, `EvaluationEstimate`, `isStateful()` (+ seek contract), `schedulingMode()` → sync \| async \| temporal, `backendPreference()` |
| ArtifactKind | `resourceClass()`, `executor()` |

A new node or trait that answers only these questions needs **no ADR change**. The *only* thing
that reopens ADR-010 is a genuinely new evaluator *question* (a new decision) — a rare, deliberate,
visible event that signals the decision set itself grew. Freeze the interface, not the enum.

### 6. Version-token semantics (first-class invariant)

Version tokens are **opaque, immutable, and monotonic with respect to semantics**: if a node's
output semantics change, the token *must* change (a missed change is a stale-cache bug — the
unforgivable failure); if semantics do not change, the provider *must strive* to keep the token
stable (a spurious change is only a cache miss — wasted work, never wrong pixels). The asymmetry is
the provider author's contract: **must** on the correctness side, **must-strive** on the reuse side.

### 7. Stateful / temporal lane

Stateful nodes (feedback, accumulators, simulations, particle systems, temporal denoisers) declare
`stateful` + a seek contract, run in a **temporal lane** (sequential, state-preserving), are
excluded from content-addressing, and preserve ADR-007 parity by *sequence-determinism* (same seek
+ same inputs → same frames in all renderers). They re-enter content-addressing only via explicit
**baking** — freezing a temporal result to deterministic artifact data.

## Alternatives considered

- **Dependency and capability as one list.** Rejected: conflation is what let `materializes` and
  `timeVarying` sit in the same bucket; the two-axis split is total (no residual overlap found).
- **`materializes` / `gpuOnly` as node metadata.** Rejected: the first is an evaluation property
  (fan-out/budget-dependent); the second fuses representation with backend. Both moved to the
  evaluator / split registries.
- **A scalar `cost`.** Rejected: a fixed number re-anchors as hardware and budgeting models change,
  forcing authors to guess drifting units. Replaced by a relative `EvaluationEstimate`.
- **A closed capability enum.** Rejected: contradicts "extend only by declaring" — a genuinely new
  trait would force an enum edit. Replaced by a closed *interface* over open registries.

## Consequences — formal invariants

1. The evaluator contains no node-type identifier and no per-type branch.
2. Two orthogonal declaration axes: dependencies → hash; capabilities → behavior. Nothing is both.
3. Every output-affecting input is a declared dependency resolving to an opaque version token;
   hidden inputs are forbidden; the evaluator never interprets a token or its precision.
4. Context is a set of declared *shared* dependencies folded **per node**; no global environment
   version.
5. Determinism is a law; nondeterminism forbidden; randomness is a `seed` dependency;
   `deterministic` is never declared.
6. Nodes declare `requiresMaterialization` + `EvaluationEstimate` only; the evaluator owns the
   materialize decision.
7. Representation (`ArtifactKind`) and execution (`Backend`) are separate axes; artifacts are
   immutable and opaque; the cache budgets per resource class.
8. Stateful nodes declare `stateful` + seek; run in the temporal lane; excluded from
   content-addressing; re-enter only via explicit baking; parity by sequence-determinism.
9. Capabilities are orthogonal; each answers one closed question; all compositions work without
   special cases.
10. The evaluator *interface* (question set) is closed; the dependency, capability, and
    artifact-kind *registries* are open. Only a new evaluator *question* reopens this contract.
11. Renderer parity is absolute (ADR-007): identical content → identical pixels across concurrent
    renderers; backend differences exist only as a keyed context axis (`rendererRevision`).
12. Version tokens are opaque, immutable, and monotonic w.r.t. semantics (§6).

## The one standing caveat

Invariant #10's boundary — "new question = reopen" — is only as strong as the review discipline
that recognizes when a proposed trait is smuggling in a new evaluator *question* versus answering an
existing one. The document cannot enforce this; it can only name it. That is a review-culture duty,
and the sole living risk after freeze.

From here, code reviews ask **"Does this implementation satisfy ADR-010?"** — never **"Should
ADR-010 change?"** Future ADRs extend registries (dependency providers, context axes, artifact
kinds, executors); the evaluator contract stays still.
