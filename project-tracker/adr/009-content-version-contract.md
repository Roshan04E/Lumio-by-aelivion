# ADR-009 — Content Version Contract (completeness rules)

- Status: Frozen
- Normative: Yes (the completeness rules); conceptually reduced by ADR-010
- Date adopted: 2026-07-23

```
Depends on:
  ADR-008 (materialization substrate)

Superseded:
  ADR-009 (earlier draft, sections 4-8: monolithic context, value quantization)
    -> superseded conceptually by ADR-010's dependency/capability model

Retained: sections 1-3 below (the completeness rules) remain normative
Implemented by: Slice 2+
```

## Context

ADR-008's cache key is `(ContractVersion, ContextVersion, NodeContentHash)`. The cache is only as
correct as this key is *complete*: any input that can change a node's output but is not folded into
the key is a silent stale-cache bug — the one unforgivable failure of a content-addressed engine.
This ADR fixes the completeness rules the version contract must satisfy forever.

The earlier draft of this contract carried a monolithic `ContextVersion` and quantized floating
values into the hash. Both were superseded during review: context monolithism forces global
invalidation on any environment change (a font swap invalidates a pure blur), and quantization is
an inconsistent, correctness-adjacent policy the hash should not own. ADR-010 replaces both with
per-node folded dependencies and provider-owned tokens. What survives as normative here are the
three completeness rules.

## Decision — the completeness rules (normative)

**R1 — Resolve drivers to values.** The hash folds the *resolved value at time t*, never the driver
that produced it. A keyframed parameter contributes its evaluated value; an expression contributes
its result; a driver's structure never appears in the key. Two nodes that resolve to the same value
at time t are the same content.

**R2 — Declared dependencies only, all of them.** Every input that can affect output is a
**declared dependency** resolving to an opaque **version token** (ADR-010). Hidden inputs are
forbidden. The hash is `fold(local-dependency tokens)`; the applicable context is
`fold(shared-dependency tokens)`, folded **per node** — never applied as one global environment
version. A node that reads nothing from the environment carries no context; a font change cannot
invalidate a node that declares no font dependency.

**R3 — Topology is explicit.** The hash includes the node's *resolved upstream content hashes* and
its position/wiring in the evaluated subgraph. Rewiring a graph changes downstream hashes even when
every param is untouched. Fan-in order is part of content.

Plus two framing constants:

- **ContractVersion** is bumped by hand when the *meaning* of the hash changes (a new mandatory
  dependency class, a fold-algorithm change). It is the global escape hatch that invalidates every
  cache across a breaking contract change.
- **Exclusion list (never hashed):** editor-only state (`ui`, `view`, `previewNodeId`, selection),
  performance hints (`EvaluationEstimate` — ADR-010), and anything that cannot change output.
  Hashing these causes spurious misses, which is wasted work, never wrong pixels — but the
  discipline keeps reuse high.

## Alternatives considered

- **Single monolithic ContextVersion.** Rejected: forces global invalidation; a pure node pays for
  unrelated environment churn. Replaced by per-node folded shared dependencies.
- **Quantize float params before hashing.** Rejected: an inconsistent, correctness-adjacent policy;
  the token/provider owns its own precision (ADR-010), the hash stays a pure fold.
- **Hash the drivers (keyframe tracks, expressions).** Rejected: violates R1 — two equal resolved
  values would key differently and never share a cache slot.

## Consequences

- The version contract never enumerates node types or input names; it enumerates **rules** every
  dependency must satisfy. New input classes are new dependency providers (ADR-010), not edits here.
- A missed dependency is a correctness bug; a spurious one is a performance bug. R2 makes the first
  structurally impossible for *declared* inputs and pushes the burden onto the honesty of the
  declaration — which ADR-010's forbidden-hidden-input rule enforces.
- This ADR is deliberately small. Its job is to state R1–R3 + ContractVersion + the exclusion list
  and then get out of the way. The dependency *taxonomy* lives in ADR-010's open registry, not here.
