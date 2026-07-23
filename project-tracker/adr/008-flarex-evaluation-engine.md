# ADR-008 — Flarex Evaluation Engine (content-addressed materialization substrate)

- Status: Frozen
- Normative: Yes
- Date adopted: 2026-07-23

```
Depends on:
  ADR-007 (renderer parity-by-construction)

Extends:
  Slice 1 materialization boundary (evaluationKey, __flarexSealed)

Superseded-by: (none)
Implemented by: Slice 2+
```

## Context

ADR-007 froze the Flarex **lowering compiler**: every frame, `compileFlarexComp` re-translates
the whole graph into the same `SceneDraw` primitives an ordinary clip emits, and the generic
`SceneCompositor` evaluates them. Parity is free (preview == export), but it is also the ceiling —
no node-level cache, no node-owned render target, no async/ML node, no node preview, because
"evaluation" is borrowed from the timeline compositor by disguising the graph as timeline draws
(see `plans/flarex-evaluation-engine.md`, "What evaluation means today").

The missing architectural layer sits **between lowering and the compositor** and owns node
identity: it caches a node's result, materializes a node to a texture when it cannot be a pure
per-frame fold, and schedules async node work. That layer is the evaluation engine. The Slice-1
review surfaced three traps that shaped this ADR: (a) identity is not validity — a stable
`evaluationKey` is a cache *slot*, never proof the slot's contents are current; (b) wrapping a
group to materialize it double-RTTs group-valued inputs; (c) a `materializeNodeIds` policy pushed
in from outside conflates debug override with the engine's own budgeting decision.

## Decision

The evaluation engine is a **content-addressed materialization substrate** layered on the ADR-007
compiler. Four rules:

1. **Cache the content, not the node.** The cache key is `(ContractVersion, ContextVersion,
   NodeContentHash)` (the content-version contract, ADR-009), *not* the node's identity.
   `evaluationKey` (Slice 1) is the runtime **slot identity** used for resource ownership,
   profiling, and eviction bookkeeping; it never decides validity. Identity ≠ validity is the
   load-bearing invariant.

2. **Materialize by tagging, not wrapping.** A materialized node is an existing `SceneGroupDraw`
   flagged `__flarexSealed` (an optimization barrier the wrap-collapser never folds through),
   carrying its `evaluationKey`. The engine tags the group the compiler already emits; it does not
   wrap a second group around it. Group-valued results therefore materialize with **one** RTT, not
   two. This rides the existing `renderGroupInto` / depth-pooled `groupTargets` machinery in
   `scene-compositor.ts` — materialization makes an implicit RTT boundary explicit and
   identity-bearing, it is not a new rendering path, so ADR-007 parity holds by construction.

3. **The evaluator owns the materialization decision.** Nodes never declare "I materialize."
   They declare an intrinsic constraint (`requiresMaterialization`) and a work estimate; the
   evaluator computes `materialize = requiresMaterialization ∨ fanout>1 ∨ budget(estimate) ∨
   debugOverride`. Policy is centralized in one place. (Full ownership split: ADR-010.)

4. **Two roles, cleanly split.** The **evaluator** owns node identity, the content-addressed
   cache, invalidation, fan-out analysis, scheduling, and the materialize decision — and knows *no
   node types*. The **compositor** owns GL context, RTT pools, texture residency, and pixel
   lifetime — and knows *no graph*. Anything the evaluator materializes is either deterministic
   data all three renderers re-derive, or a texture produced through the shared `SceneCompositor`.
   It is never a web-only GPU artifact export cannot reproduce.

## Alternatives considered

- **Key the cache on `evaluationKey` (node identity).** Rejected: the Slice-1 review's stale-cache
  trap — identity survives a param edit, so a node-keyed cache returns last frame's pixels for this
  frame's params. Content addressing makes staleness structurally impossible.
- **Materialize by wrapping the node in a fresh group.** Rejected: double RTT on group-valued
  inputs; tagging the existing group is exact and cheaper.
- **External `materializeNodeIds` policy as the production mechanism.** Rejected as production
  policy; retained only as a **debug override** term in the evaluator's decision. The engine, not
  its caller, decides materialization from fan-out and budget.
- **A web-only GPU node cache.** Rejected: violates ADR-007. Async/ML results must be deterministic
  artifact data (`MaskSequenceArtifactData`, `TrackingPathArtifactData`) that export re-derives.

## Consequences

- Slice 1's `evaluationKey` + `__flarexSealed` are the durable seam; Slice 2 promotes the per-call
  `memo` to a persistent content-addressed cache keyed by `NodeContentHash`, not `evaluationKey`.
- The cache stores **immutable, opaque artifacts** budgeted per resource class (VRAM/RAM/…);
  eviction is per-pool (see ADR-010 ArtifactKind → resource class).
- Correctness is verifiable independent of materialization: a materialized node must match its
  folded twin within the pixel floor (`render:compare:pixels`), and a cache hit must be
  byte-identical to a cold recompute. These are the two Slice-2 gates.
- Async/stateful nodes get a first-class home (ADR-010 temporal lane + async scheduling) without
  breaking parity, because their output re-enters content-addressing only as deterministic data or
  via explicit baking.
- What the engine must **never** grow: a per-node-type branch in the evaluator, or a cache whose
  validity depends on identity rather than content. Either is a demonstrable architectural flaw and
  the only cause to revisit this ADR.
