# ADR-011 — Evaluation Context Transform (the fourth evaluator question)

- Status: Provisional
- Normative: Yes
- Date adopted: 2026-07-28

```
Depends on:
  ADR-007 (renderer parity-by-construction)
  ADR-008 (materialization substrate)
  ADR-009 (completeness rules R1-R3)
  ADR-010 (node capability contract)

Extends: ADR-010 §5 (the closed question set) — adds ONE question. Does not supersede it.

Implemented by: TimeSpeed (first case)
```

## Context

ADR-010 froze the evaluator against a **closed set of questions** over **open registries**, and named
the single condition that reopens it: *"a genuinely new evaluator question (a new decision) — a rare,
deliberate, visible event that signals the decision set itself grew."* This is the first invocation of
that clause. It is being written before the feature that needs it, not after.

**The case.** A retime node (Fusion's `TimeSpeed`/`TimeStretcher`) does not *read* time. It **rewrites
the time at which its upstream subtree is evaluated**. Checked against ADR-010 §5, no existing question
expresses this:

| Registry | Existing questions | Can any express "evaluate my inputs at a different t"? |
|---|---|---|
| Dependency | `versionToken()`, `scope()` | No — a dependency contributes a token to a fold; it cannot change what is folded |
| Capability | `requiresMaterialization()`, `EvaluationEstimate`, `isStateful()`, `schedulingMode()`, `backendPreference()` | No — all describe how a node is executed, not what its inputs are asked |
| ArtifactKind | `resourceClass()`, `executor()` | No — representation and backend |

Under R1 the hash folds *the resolved value at time t*; under R3 it folds *resolved upstream content
hashes*. Both are well-defined only once you know which `t` the subtree was evaluated at. A retime node
changes that `t` for everything above it, so it is not contributing a token — it is altering the
question every upstream node is asked. That is a decision, and decisions belong to the evaluator.

**Why the cheap alternative was rejected.** A retime lowered at compile time, scoped to `MediaIn`
source sampling, needs no ADR change and covers "play this clip at 50%". It was rejected on the product
criterion the founder set: *whichever favours a professional NLE*. In Fusion, a TimeSpeed above a noise
generator slows the noise; above an animated blur it slows the animation. A node that retimed video
sources while silently ignoring animated parameters and generators would not read as limited, it would
read as broken — and the two are not nested (different socket shape, different inspector copy), so the
narrow one could not be widened later without a rename. Shipping the narrow shape while implying the
general one is the v32i merge-blend failure restated: *two constructs sharing a lowering shape do not
share its semantics.*

## Decision

**Add exactly one question to the closed set: `inputContextTransform()`.**

```
Capability / execution trait registry (ADR-010 §5), extended:
    inputContextTransform() -> ContextTransform | null      # NEW (this ADR)
```

A node may declare a transform applied to the **evaluation context** handed to its inputs. The
evaluator composes transforms down the traversal; the transformed context is what upstream nodes are
evaluated in, and it participates in identity exactly as an untransformed one does.

### 1. The transform is data, not a function

`ContextTransform` is a declared, serializable value (for time: `{ axis: "time", scale, offset }`),
never a callback. Three consequences, all load-bearing:

- It is **inspectable** — the evaluator can fold it into a key without executing anything.
- It is **composable** — nested retimes compose by value, and the composition is computable ahead of
  evaluation rather than discovered during it.
- It preserves **ADR-007 parity by construction** — preview and Remotion compose identical declared
  values. A callback would be code that must match across renderers, which is precisely the class of
  divergence ADR-007 exists to make impossible.

### 2. The transformed context is part of identity

The composed transform folds into `applicableContext` for every node beneath it. Two evaluations of the
same subgraph under different transforms are **different content** and must not share a cache entry.
This follows from R2 (declared dependencies, all of them) and is stated explicitly because the failure
mode — a subtree returning a frame computed at the wrong `t` — is a stale-cache bug, the failure
ADR-009 §6 calls unforgivable.

### 3. Axis-scoped, open, and total

`ContextTransform` carries an **axis**. `time` is the first; the registry is open, per ADR-010's
"freeze the interface, not the enum". A node transforming an axis an upstream node does not read
changes nothing for it — a transform is not a broadcast.

### 4. What this does NOT permit

- **Not a general context write.** A node transforms the context handed to *its own inputs*. It cannot
  write into a sibling's context, a downstream context, or a global.
- **Not an escape from determinism.** ADR-010 §2 still holds: same inputs, same context, same output.
  A transform is part of "same context".
- **Not a route around statefulness.** A stateful node under a retime still runs in the temporal lane
  (§7) and still honours its seek contract; the transform changes the seek target, not the lane.

### 5. Boundary: transforms and source sampling

A `MediaIn` under a time transform samples its source at the transformed time. This is the same
computation the timeline's own speed/ramp already performs (`getLayerSpeed`, `rampTangent`,
`mapSourceTime`) and must produce identical results for identical effective speed — the timeline and
the node graph are two dialects of one retime, not two implementations of it.

## Alternatives considered

- **Compile-time lowering scoped to source sampling.** Rejected above on the professional-NLE
  criterion. Recorded in full in `plans/flarex-timespeed-tracker.md` §2 option C.
- **Declare retime `stateful` to borrow the temporal lane.** Rejected. Retiming is *pure* — same input,
  same `t`, same output — so the declaration would be false, and it would forfeit content-addressing
  for a node that deserves it. ADR-010 §7's lane exists for feedback and accumulators; using it as a
  general escape hatch is how a frozen contract rots.
- **A callback-valued transform.** Rejected: not inspectable, not composable ahead of evaluation, and
  it reintroduces cross-renderer code divergence that ADR-007 removes by construction.
- **Widening `time` into a shared-scope dependency.** Rejected: shared scope means "the environment",
  and a retime is emphatically *local* — it applies to one subtree. Widening it would make every node
  in the comp context-dependent on a transform most of them never see, contradicting R2's per-node
  folding ("a font change cannot invalidate a node that declares no font dependency").

## Consequences

1. The closed question set grows from nine to ten. It remains closed; the registries remain open.
2. The evaluator gains one decision — *what context do my inputs evaluate in?* — and still contains no
   node-type identifier and no per-type branch. ADR-010 invariant 1 holds.
3. Nested retimes are well-defined by value composition.
4. Cache keys beneath a transform differ from those above it. Correct, and the reason §2 is normative.
5. **Provisional, not Frozen.** ADR-010 froze after implementation proved it. This freezes when
   TimeSpeed ships and a second axis or a second transforming node confirms the shape generalises. If
   the first implementation finds the transform wants to be a function rather than data, this ADR falls
   rather than bends.
