# Flarex Evaluation Engine — Architecture Audit & Roadmap

> Status: **architecture frozen** — implementation phase. The evaluation-engine design is settled
> in ADR-008/009/010 (frozen 2026-07-23); this doc is the audit that motivated them plus the
> shippable slice roadmap. Implementation must **satisfy** the frozen contract, not redefine it —
> if a slice seems to require an architectural change, that is an ADR question, not a plan edit.
> Audit date: 2026-07-23.
>
> Governance: `project-tracker/adr/`.
> - **ADR-007** — parity-by-construction: the engine may NOT become a web-only GPU cache export
>   doesn't share; anything materialized is deterministic data all three renderers re-derive, or is
>   built through the SHARED `SceneCompositor`.
> - **ADR-008** — the content-addressed materialization substrate (identity ≠ validity; tag-in-place
>   not wrap; evaluator owns the materialize decision; evaluator/compositor role split).
> - **ADR-009** — content-version completeness rules R1–R3 + ContractVersion + exclusion list.
> - **ADR-010** — the node capability contract: dependencies (→ hash) vs capabilities (→ behavior),
>   closed evaluator interface over open registries. The document every node author reads first.

## One-sentence finding

Flarex has a lowering **compiler**, not an evaluation **engine**. Every frame,
`compileFlarexComp` re-translates the whole graph into the same `SceneDraw` primitives an
ordinary clip emits, and the generic `SceneCompositor` evaluates them. Great for parity
(preview == export for free); it is also the ceiling — no node-level cache, no node-owned render
target, no async node, no node preview, because "evaluation" is borrowed from the timeline
compositor by disguising the graph as timeline draws.

## Pipeline stages

### 1. Node Definitions — `packages/shared/src/flarex/node-defs.ts`, `types.ts`, `registry.ts`
- **Responsibilities:** declare node types — typed sockets (`image`/`matte`/`number`), Zod param
  schema + defaults (`parseFlarexNodeParams` = single normalization gate), keyframeable keys,
  palette group, `phase` gate.
- **In/Out:** static catalog → `FlarexNodeDefinition` for palette, AI surface, compiler.
- **Current:** complete, renderer-free, 23 node types.
- **Missing:** no **data socket** (tracker path / spline / number-stream); `outputs` declared but
  compiler assumes single output.
- **Debt:** `phase` keeps unbuilt nodes (`aiMatte`/`text`/`tracker`) in the union + catalog but
  unlowered → user can reach them, gets silent pass-through.

### 2. Graph — `FlarexComp` in `ProjectGraph.flarexComps`
- **Responsibilities:** `nodes`, `edges`, node-param `animations` (`scope:"flarexNode"`),
  monotonic `version` (dirty key), editor-only `view`, `previewNodeId` (Fusion view-dot).
- **In/Out:** `flarex.*` timeline actions mutate + bump `version`; referenced by
  `TimelineLayer.flarexCompId`.
- **Current:** solid; registry pattern inherits persistence/sync/undo from nested comps.
- **Debt:** `version` is **whole-comp** granularity — any edit invalidates all downstream.

### 3. Compiler / Lowering — `packages/shared/src/flarex/compile-flarex.ts` (the heart)
- **Responsibilities:** deterministically lower `(comp, ctx)` → `SceneDraw` subtree. Pull eval:
  memoized backwards DFS from MediaOut (or `previewNodeId`). Two value kinds: **image**
  (`SceneLayerDraw`/`SceneGroupDraw`) and **matte** (vector `Mask[]`, kept vector until applied so
  MatteControl combines losslessly). Wrap-collapsing folds consecutive ops into one group by fixed
  shell stage order (pipeline→region→fragment→transform→blur→glow→mask) within `NEST_MAX_DEPTH`.
- **Inputs:** `FlarexLowerCtx` — comp size, `renderScale`, comp-local `timeSeconds`, global
  `frameTimeSeconds`, host clip draw (= MediaIn), `matteCache`, `resolveSourceDraw`.
- **Outputs:** one `FlarexImageValue | null`.
- **Current:** ~15 node types lower for real (merge/transform/color/curves/blur/glow/sharpen/
  filter/keyers/shape-masks/matteControl/reroute). Cycle-safe (`visiting` set). Soft-degrade.
- **Missing:** `aiMatte`→null; `text`/`tracker`→pass-through. No materialization. **No cross-frame
  cache** — `memo` Map is created inside the function, per call.
- **Debt:** effect-param-key coupling to color/fragment registries (colorCurves/hueSat singular↔
  plural key mismatch); `matteControl` invert exact only for add-combined mattes; hardcoded
  knowledge of `brightnessContrast`/`colorCurves`/`sharpen`/chroma/luma ids = main churn surface.
- **Perf:** pure CPU structure-building, but runs in full **every frame, per Flarex clip**; linear
  in node count with zero reuse.

### 4. Execution — *there is none, separately*
- The crux. `build-scene-draws.ts::applyFlarex` calls `compileFlarexComp` synchronously at the end
  of each layer's draw build and splices the result at the clip's z-slot. Execution of a Flarex
  graph **is** the same pass that executes the timeline. No scheduler, work queue, dirty walk, or async.

### 5. GPU / CPU — `color/scene-compositor.ts` (`SceneCompositor`), `scene/scene-mask-matte.ts`
- **Responsibilities:** WebGL2 compositor consumes `SceneDraw[]`; owns GL context, group/nest
  RTTs, texture upload (skips re-upload via `sourceVersion`/`maskVersion`). `SceneMaskMatteCache`
  rasterizes vector masks to textures (2D canvas), cached by key+version.
- **Current:** real, shared by all three renderers; wrap-collapsing bounds RTT/nest count.
- **Missing (for Flarex):** no **node-granular** RTT ownership/cache — caches are keyed by
  layer/effect/mask identity, never node identity.
- **Perf:** each Merge/materialization = one nest RTT; deep graphs pay in RTT count + bandwidth.

### 6. Viewer — `ScenePreviewCanvas` (editor), `SceneFrameCompositor` (export), `SceneStage` (Remotion)
- **Responsibilities:** own compositor + matte cache + grade pool; `buildSceneDraws` →
  `SceneCompositor.renderFrame`. Remotion gates via `delayRender`; web preview via
  `onLayerNotReady` + rAF.
- **Current:** all three pass `flarexComps`/`flarexVirtualLayers` straight through; parity holds.
- **Missing:** **node previews do not exist** — node canvas only marks `previewNodeId`; the only
  way to inspect a node is to re-root the whole viewer at it (which also changes export).

### 7. Final Output — Remotion / local export → mp4
- Deterministic because lowering is deterministic + shared. Nothing Flarex-specific.

## What "evaluation" means today

| Question | Today |
|---|---|
| Execution order | Pull-based memoized backwards DFS from MediaOut / `previewNodeId`. |
| Dependency resolution | `edgeInto: Map<"nodeId:socket", fromNodeId>`; one wire per input, healer-enforced. |
| Dirty tracking | Coarse whole-comp `version`; within a frame compile always runs fresh → no node-granular dirty. |
| Cached textures | None at node level. Compositor caches by layer/effect/mask version; matte cache by mask key+version. Node output image never cached. |
| GPU resource ownership | `SceneCompositor` owns all GL/RTTs; compiler owns nothing GPU. |
| Render-target reuse | Group/nest RTTs; wrap-collapsing minimizes nests a chain opens. |
| Async nodes | Not modeled. Punted to layer decode (asset-source MediaIn pre-decodes virtual layer; `resolveSourceDraw`→null until ready). `aiMatte`→null. |
| Cancellation | None in compiler (synchronous µs-scale); lives in media decode pipeline. |
| Playback ↔ evaluation | Compile re-runs every frame in `buildSceneDraws`; no incremental/inter-frame reuse. |
| Timeline time | `timeSeconds` = comp-local (t − clipStart) drives keyframes; `frameTimeSeconds` = global (fragment `uTime`). |
| Node previews | Not generated. |
| Viewer selection | `previewNodeId` persisted; compiler roots there; affects preview AND export by design. |
| Compile vs runtime | **Not separated — same thing.** Lowering IS evaluation; the "runtime" is the generic compositor that knows nothing about Flarex. |

**The missing boundary** = a layer between lowering and compositor that owns node identity:
caches a node's result, materializes a node to a texture when it can't be a pure fold, schedules
async node work. That layer **is** the evaluation engine.

## Implementation slices (each ships a working improvement; no big bang)

### Slice 1 — Materialization boundary ("render a node to a texture")
Give the compiler one capability: emit a node as a forced nest/RTT with a **stable cache key**
(`nodeId + paramsHash@time + upstreamHash`) instead of a fold. Rides the existing
`SceneGroupDraw` nest = RTT machinery → lands in the shared compositor, parity holds. Unlocks
nodes that can't fold (distortion, iterative, feedback) and is the prerequisite for caching.
*Ships:* a node that must rasterize renders correctly. Verify: `render:compare:pixels`.
**OPEN QUESTION before coding:** confirm wrap-collapse / `NEST_MAX_DEPTH` interaction — a
materialized node deliberately opens a nest, so it must count against the depth budget correctly
rather than fight the collapser.

### Slice 2 — Content-addressed evaluation cache (implements ADR-008/009/010)
Promote per-call `memo` to a persistent comp-scoped cache. **Key is content, not identity:**
`(ContractVersion, ContextVersion, NodeContentHash)` per ADR-009 R1–R3 — NOT the Slice-1
`evaluationKey` (that stays the runtime slot identity for resource ownership/eviction only;
ADR-008 rule 1, identity ≠ validity). Static subgraphs (grade on a still, unkeyframed mask) stop
recomputing every frame; a rewire or param edit changes the hash and invalidates automatically.
Materialize by **tagging** the compiler's existing `SceneGroupDraw` (`__flarexSealed`), never by
wrapping a second group (ADR-008 rule 2 — one RTT, not two). The materialize decision is
evaluator-owned (`requiresMaterialization ∨ fanout>1 ∨ budget ∨ debugOverride`), driven by the
node capability declarations of ADR-010 — no node-type branches in the evaluator. Pure
lowering-side, no compositor change → ship web-first.
*Ships:* measurable playback speedup; first reuse-scorecard data point (frame time before/after).
*Gates (ADR-008 consequences):* (a) `render:compare:pixels` stays at the pixel floor — a
materialized node matches its folded twin; (b) a cache hit is byte-identical to a cold recompute.
*Contract debt to retire as declarations land:* the compiler's hardcoded node-id knowledge
(`brightnessContrast`/`colorCurves`/`sharpen`/chroma/luma) becomes ADR-010 dependency/capability
declarations — the evaluator must not read node ids.

### Slice 3 — Async node protocol
Node needing async work (aiMatte ML seg, tracker solve): return `pending` sentinel + soft-degrade
(MediaIn pattern), schedule keyed by `node+inputsHash` via existing `tool-runner`/`artifact-store`,
cache result as **deterministic artifact data** (`MaskSequenceArtifactData`,
`TrackingPathArtifactData` already in `shared/masks.ts`), re-lower when ready. Result is data that
lowers to existing primitives → export re-derives it → parity preserved. *Ships:* aiMatte + tracker
produce real output end-to-end.

### Slice 4 — Node previews (roadmap "viewer overlays")
With 1–2, per-node thumbnail is cheap: root compile at each visible node, render its materialized
texture at thumbnail res, editor-only (previews never touch output). *Ships:* highest visible-value
feature; makes the graph legible.

### Slice 5 — Data sockets / multi-output
Add `data` socket type so `tracker` emits a path that `transform`/`text` consume as an input
binding (not an image). Where tracking + text nodes mature. Depends on Slice 3; lowest priority.

## Roadmap ordered by engineering value

1. **Slice 1 (materialization)** — unblocks every node class that can't fold; foundation for 2 & 4. Highest leverage.
2. **Slice 2 (node cache)** — playback perf + operationalizes the reuse scorecard.
3. **Slice 4 (node previews)** — do BEFORE Slice 3: cheap once 1–2 land, biggest usability jump.
4. **Slice 3 (async nodes)** — turns aiMatte/tracker from dead palette entries into real features; heaviest, after the cheap wins.
5. **Slice 5 (data sockets)** — completes tracking/text; smallest audience, last.

Each milestone is independently shippable + verifiable via `render:compare:pixels` (parity gate)
and a frame-time measurement (scorecard). None touches the frozen foundations — **that is the
test**: if the evaluation engine fits entirely inside the ADR-007 compiler contract + the shared
compositor, with no new inspector control, no new `PropertyField` kind, no renderer branch, the
architecture froze at the right time.

**Recommended first step:** Slice 1, after confirming the `NEST_MAX_DEPTH` interaction above.

---

## Slice 1 — Reviewed & Approved Implementation Plan (2026-07-23)

**Open question resolved:** `NEST_MAX_DEPTH=8` is NOT a hard cap on the Flarex/compositor path.
It lives in `nesting.ts` for the compound-clip expander only; the compositor's
`groupTargetsForDepth` (`scene-compositor.ts`) grows the RTT pool dynamically. Every
`SceneGroupDraw` the compiler emits already becomes an isolated RTT at composite time
(`renderGroupInto`). Materialization is therefore not a new rendering path — it makes an existing
implicit RTT boundary explicit and identity-bearing. A materialized node costs at most one extra
pooled RTT depth level; nothing fights the collapser or a limit.

**Two review changes applied:**
1. **No serialized execution flag.** There is NO `params.materialize` and no persisted flag.
   Runtime execution policy stays OUT of node params and OUT of persisted project data. The opt-in
   is a runtime-only field on `FlarexLowerCtx` (`materializeNodeIds?: ReadonlySet<string>`), which
   is constructed per-frame and never serialized. Only the test sets it in Slice 1; the production
   caller (`build-scene-draws.ts`) omits it → dormant → byte-identical output.
2. **Identity field named `evaluationKey`** (not `materializeKey`) — this runtime node identity is
   reused later by caching, profiling, GPU-resource ownership, and async evaluation.

### Approved modifications
- **M1 — `SceneGroupDraw.evaluationKey?: string`** (`packages/shared/src/color/scene-compositor.ts`,
  type only). Runtime-only, never serialized. Compositor does NOT read it in Slice 1. The durable
  seam later slices key on. Undefined on every group today → byte-identical.
- **M2 — compiler sealed boundary** (`packages/shared/src/flarex/compile-flarex.ts`):
  `FlarexWrapGroup` gains `__flarexSealed?: boolean`; new `materialize(draw, nodeId)` builds a sealed
  `newWrap` stamped with `evaluationKey = flarex_${comp.id}_${nodeId}`; `wrapFor` never reuses a
  sealed wrap (early-out); `cloneImage` preserves the seal. Opt-in is `ctx.materializeNodeIds` —
  no `lowerNode` case forces it; production caller passes nothing. Determinism preserved (ids only,
  never `ui`/`view`).
- **M3 — assertions** (`packages/shared/src/flarex/flarex.test.ts`): normal comp unchanged;
  materialized node emits a group with the right `evaluationKey`; a downstream op does NOT fold into
  a sealed node but STILL folds into a non-sealed one.
- **Untouched:** `build-scene-draws.ts` splice, the three viewers, inspectors/adapters/theme,
  `node-defs.ts`, the graph schema.

### Commit breakdown (one reviewable step each, wait for review between)
1. **M1** — add the optional `evaluationKey` field to `SceneGroupDraw` (additive, unread). ← first.
2. **M2** — compiler sealed-boundary mechanism + runtime opt-in (dormant; existing output identical).
3. **M3** — test assertions + (recommended) an opt-in parity fixture proving a materialized node
   matches its folded twin within the pixel floor.

### Parity / performance / rollback
- Existing Flarex fixtures stay **0.000%** on `render:compare:pixels` (no output change).
- Parity proof for when it is used: nesting is already pixel-exact, so a materialized node must match
  its folded twin within the pixel floor (new opt-in fixture, step 3).
- Zero perf impact while dormant; one extra pooled RTT depth level when used; no caching yet (Slice 2).
- Rollback is trivial: fully additive + dormant; nothing persisted depends on it.
