# ADR-007 — Flarex Compiler Contract (lowering to SceneDraw)

- Status: Stable (the lowering contract); the **evaluation engine** built on top is frozen in ADR-008/009/010
- Date adopted: 2026-07-23 (documenting the Phase 1/2 compiler)

## Context

A node-based compositor (Flarex) must produce pixels in three renderers that are required to
stay pixel-aligned: the web preview (`ScenePreviewCanvas`), the local export
(`SceneFrameCompositor`), and the Remotion worker (`SceneStage`). Building a Flarex-specific GPU
runtime in each would guarantee drift — the exact class of bug the render-manifest contract
exists to prevent.

## Decision

Flarex renderers **never read the graph**. A deterministic lowering compiler
(`packages/shared/src/flarex/compile-flarex.ts`) turns a `FlarexComp` into the **same
`SceneDraw` primitives** (`SceneLayerDraw` / `SceneGroupDraw` / region + fragment passes / masks)
that `build-scene-draws.ts` already emits for ordinary clips. Parity is **by construction**: the
compiler touches no GL; all three renderers consume its output through the one `buildSceneDraws`
hook (`applyFlarex`), so a comp splices into the clip's z-slot as an ordinary draw subtree.

Contract invariants:
- **Determinism:** node `ui` / comp `view` are editor-only and MUST NOT influence lowering.
  Same `(comp, ctx)` → structurally identical draws.
- **Dirty key:** `comp.version` (monotonic) is the sole invalidation key; preview memo keys
  include `(flarexCompId, version)`.
- **Soft-degrade, never black:** a broken graph (cycle, dangling input, matte-only chain) returns
  `null` → the caller falls back to the plain clip draw; only an intentionally unwired MediaOut
  renders transparent.
- **Pull evaluation:** memoized backwards DFS from MediaOut (or `previewNodeId`, the Fusion
  view-dot, which re-roots preview AND export by design).
- **Time model:** `timeSeconds` is comp-local (t − clip start) driving node keyframes;
  `frameTimeSeconds` is global (fragment `uTime` parity). Asset-source MediaIn decodes
  off-timeline via virtual loaders (`virtual-layers.ts`) fed through `resolveSourceDraw`.

## Alternatives considered

- **A Flarex-specific GPU graph runtime per renderer.** Rejected: three implementations, drift by
  construction, violates the render-manifest contract.
- **Lower once at edit time, cache the draw list.** Rejected: node params are keyframed, so the
  draw list is time-varying; lowering is per-frame and must stay cheap/pure.

## Consequences

- Every node must express itself as existing `SceneDraw` primitives (transform / pipeline /
  fragment pass / region pass / mask / blur / glow / group), folded via the wrap-collapse stage
  order within a `NEST_MAX_DEPTH` budget.
- **This is the ceiling the evaluation-engine milestone addresses:** nodes that cannot be a pure
  per-frame fold (async ML matte, tracker solves, iterative/feedback image ops, per-node caching,
  node previews) have no first-class home today — `aiMatte`/`text`/`tracker` are declared but
  pass through/return null. The evaluation engine must lift this ceiling **without** breaking the
  parity-by-construction contract above (any materialized result must be deterministic data that
  all three renderers re-derive, not a web-only GPU artifact).
- **Known debt** carried by the current compiler: per-frame full re-lowering (no cross-frame node
  cache); effect-param-key coupling to the color/fragment registries (e.g. colorCurves/hueSat
  singular↔plural key mismatch); `matteControl` invert exact only for add-combined mattes
  (documented approximation); Phase 1.5+ palette nodes that silently pass through.
