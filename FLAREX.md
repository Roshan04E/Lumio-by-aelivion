# FLAREX — Fusion-Style Node Compositing Page

> Reference doc for the Flarex ("CG page") effort: a DaVinci-Resolve-Fusion-style node-based
> GPU compositing workspace inside the Orreris editor. Companion trackers:
> `architecture.md` (ship/defer status), `project-tracker/` (problem/solution logs).
> Written 2026-07-21.

## Goal

A top-level **page system** — Edit ↔ **Flarex** — where the user selects a clip on the Edit
page, switches to Flarex, and edits that clip's node composition: merge trees, transforms,
masks, keying, color, blur/glow, text, tracking, AI mattes. Covers ~90% of everyday Fusion
use so users never leave the editor for basic VFX/compositing. Fully linked (same project,
same transport, instant switch), AI-driven on the same principle as the Edit page (LLM emits
compact intent → deterministic shared compiler expands to a real editable graph), and fast on
Iris Xe / M1-class laptops. Ambition: the most advanced browser-based compositing workspace.

## Part 0 — What we can achieve in a browser (honest feasibility)

A browser on a 2023+ laptop (integrated GPU, 16GB RAM) can run a Fusion-class **2D
compositing** workspace at interactive speeds — merge trees, transforms, masks/roto, keying,
color ops, blur/glow stacks, tracking, text — at 1080p realtime and 4K near-realtime, IF the
engine is GPU-resident (one WebGL2 context, textures never leave VRAM between nodes,
proxy-aware). That covers the "90% of what people open Fusion for."

NOT promised at parity: Fusion's full 3D system (shadow-casting renderers), deep/volumetric
compositing, fluid sims, heavy particle counts. Credible "2.5D" (image planes + camera) and a
modest GPU particle system are v3 ambitions, not the core promise.

What each browser technology buys us:

| Tech | What it gives Flarex | Baseline |
|---|---|---|
| **WebGL2** | The node engine core: FBO ping-pong per node, in-shader blending. Already the repo's entire visual backbone — and the only way to keep parity-by-construction with local + Remotion export. | everyone |
| **WebGPU** | Optional accel only: compute-heavy ML nodes (matting, depth, flow). NEVER required; zero WebGPU exists in the render path today and introducing it there would break 3-renderer parity. | progressive |
| **WebCodecs** | HW decode feeding MediaIn as textures; already powers export + preview decode. | Chromium + Safari |
| **OffscreenCanvas/Workers** | Export already composites in a worker; decode/proxy/ML already in workers. Flarex viewer stays main-thread (shared-context grading requires it) — the Edit preview already proves that works. | everyone |
| **WASM(+SIMD)** | Tracker solves, future planar/mesh tracking. | everyone |
| **OPFS** | Frame/proxy/artifact caches that survive reload (already: source proxies, artifact-store). | everyone |
| **transformers.js / local ML** | AI matte node, depth, tracking — the local-transcription/SAM/segmentation patterns already exist in `apps/web/src/tools/`. | progressive |

Performance model (why it won't lag): each node = 1–3 shader passes into pooled FBOs; a
30-node tree at 1080p is well under 8ms on Iris Xe **if there are zero CPU readbacks** in the
interactive loop. Dirty-node caching (only downstream of an edited param re-renders),
proxy-res while dragging (existing `adaptive-quality` renderScale 1→0.5→0.25), lazy shader
compile + prewarm, VRAM LRU budget (~256MB of node RTTs in v2). Interactive budget: 16ms at
proxy res; full-res settle allowed 100–300ms.

## Part 1 — What already exists (the substrate)

- **Method 3 pipeline**: `packages/shared/src/scene/build-scene-draws.ts` → `SceneDraw[]` →
  `packages/shared/src/color/scene-compositor.ts` (`SceneCompositor`, WebGL2). Consumed by
  `apps/web/src/components/ScenePreviewCanvas.tsx` (preview),
  `apps/web/src/export/scene-frame-compositor.ts` (local export, OffscreenCanvas worker),
  `apps/worker/src/remotion/SceneStage.tsx` (cloud). **Preview IS export by construction** —
  Flarex must produce `SceneDraw`s, never a parallel renderer.
- **SceneDraw union**: `SceneLayerDraw` (source can be a same-context `SceneTextureSource` —
  node outputs feed downstream nodes with zero upload; transform, 16 blend modes vs `uDest`,
  mask matte, `regionPasses`, `fragmentPasses`, `matteFrom` track matte), `SceneTransitionDraw`,
  `SceneGroupDraw` (recursive nest → RTT → shell; depth-indexed pools, `NEST_MAX_DEPTH=8`).
- **Fragment-effect registry** (`packages/shared/src/color/fragment-effects/registry.ts`):
  multi-pass shader DAGs (`passes[]` with `inputs`→`uPass0..N`, `scale`, `skipWhen`), typed
  params → uniforms, mask-aware, single-source GLSL compiled identically in all 3 renderers.
  **Already a shader node graph, authored statically** (the stylize engine). Flarex makes it
  user-authored.
- **Masks**: vector `Mask` model (`packages/shared/src/clip-masks.ts`) rasterized by
  `SceneMaskMatteCache` (`packages/shared/src/scene/scene-mask-matte.ts`); AI mattes as
  `MatteRef` luma-matte videos (`packages/shared/src/masks.ts`); track mattes via `matteFrom`.
- **Color nodes for free**: managed Rec.709-linear pipeline baked to a 3D LUT
  (`color/pipeline.ts`, `lut3d.ts`), applied via `MediaWebGLRenderer({sharedGl})` — the
  grade-in-context primitive, already used for group grades.
- **Nesting precedent** (`packages/shared/src/nesting.ts`): `ProjectGraph.compositions`
  registry + `stampCompositionRegistry` write seam + `expandNestedCompositions` lowering —
  the exact pattern Flarex's registry and compiler copy.
- **AI precedent**: `packages/shared/src/color/grade-intent.ts` (Zod `.strict()` intent →
  `compileGradeIntent` → real editable effects) + the Brain cascade
  (`apps/web/src/ai/brain/router.ts`, Tier 0–4) + the timeline-action registry
  (`packages/shared/src/timeline-actions/registry.ts`) as the single Zod-validated mutation gate.
- **UI ingredients**: DPR-aware Canvas2D editors (`apps/web/src/editor/graph/GraphEditor.tsx`),
  reusable pan/zoom math (`graph-view.ts`), `useDraftLayer` draft/commit undo, the keyframe
  drawer (`BottomWorkspace.tsx`), inspector param controls, and the "Resolve dense dark
  register" design language (`plans/tools-pro-workspace.md`).
- **Persistence for free**: everything inside `ProjectGraph` auto-persists (localStorage draft
  + OPFS checkpoint + debounced server PATCH via `apps/web/src/lib/sync.ts`).

What must be built new: the node-graph **data model**, the node **canvas UI**, the
**page switcher**, and the **graph→SceneDraw compiler**.

## Part 2 — Architecture decisions (settled)

| Decision | Choice | Why |
|---|---|---|
| Where the graph lives | **First-class registry** `ProjectGraph.flarexComps: Record<id, FlarexComp>` + `TimelineLayer.flarexCompId` link (NOT a JSON blob in effect params) | Comps can reference multiple clips (Fusion comp-clip semantics), are reusable/copyable, don't rewrite a giant string per node drag; mirrors the shipped `compositions`/`nestedCompositionId` pattern; persists for free |
| Evaluation (MVP) | **Deterministic lowering compiler** in `packages/shared/src/flarex/compile-flarex.ts`: `FlarexComp` → `SceneDraw` subtree | 3-renderer pixel parity by construction; zero compositor risk; the `expandNestedCompositions` precedent |
| Evaluation (v2) | `renderNodeGraphInto` interpreter inside `SceneCompositor` with per-node RTT dirty caching | Fixes duplicated shared subtrees + nest-depth ceiling; gated by pixel parity vs the lowering path |
| GPU API | **WebGL2 only** for compositing; WebGPU only as optional ML-node accel | Parity with export/Remotion; the compositor already does everything needed |
| Page switch | **In-page workspace switcher** (`activePage: "edit" \| "flarex"` in EditorPage), NOT a route | Same loaded project, same transport, instant switch; a route remounts the 14.7k-line EditorPage |
| Node canvas | **Custom Canvas2D** (adapting `graph-view.ts` math), NOT React Flow | Repo idiom, no DOM-per-node perf cliff at 100+ nodes, node thumbnails from RTTs later, no heavy dep |
| AI | `NodeGraphIntent` Zod DSL + `compileNodeGraphIntent` in shared; `flarex.*` timeline actions; Brain Tier1 rules + Tier3 lane | Exact grade-intent template; gets the whole cascade + undo + validation for free |

## Part 3 — Data model (`packages/shared/src/flarex/`)

### `types.ts`

```ts
export type FlarexSocketType = "image" | "matte" | "number";

export type FlarexNodeType =
  | "mediaIn" | "mediaOut"
  | "merge" | "transform"
  | "colorCorrect" | "colorCurves" | "hueSat"        // lower to ColorPipeline (LUT per node)
  | "blur" | "glow" | "sharpen" | "filter"           // filter wraps any fragment builtin by id
  | "rectMask" | "ellipseMask" | "polygonMask" | "bezierMask"
  | "matteControl"                                    // combine/invert/feather/choke mattes
  | "chromaKey" | "lumaKey"
  | "text"
  | "aiMatte"                                         // v1.5: MaskSequence artifact input
  | "tracker";                                        // v2

export interface FlarexNode {
  id: string;
  type: FlarexNodeType;
  label?: string;
  enabled: boolean;                                   // false = pass-through (Fusion Ctrl+P)
  params: Record<string, string | number | boolean>;  // complex payloads JSON.stringify'd (repo convention)
  ui: { x: number; y: number };                       // UI-only; MUST NOT affect lowering output
}

export interface FlarexEdge {
  id: string;
  from: { nodeId: string; socket: string };           // { nodeId:"blur1", socket:"out" }
  to:   { nodeId: string; socket: string };           // { nodeId:"merge1", socket:"fg" }
}

export interface FlarexComp {
  id: string;
  name: string;
  nodes: Record<string, FlarexNode>;
  edges: FlarexEdge[];
  animations: TimelineKeyframeV2[];  // target { scope:"flarexNode", effectId: nodeId, property: paramKey }
  version: number;                   // monotonic edit counter = THE dirty/invalidation key
  view?: { panX: number; panY: number; zoom: number }; // persisted view state, never read by compiler
}
```

`packages/shared/src/types.ts` additions: `TimelineLayer.flarexCompId?: string`,
`ProjectGraph.flarexComps?: Record<string, FlarexComp>`, keyframe scope union gains
`"flarexNode"`.

### `node-defs.ts` — node definition registry (mirrors fragment-effects + timeline-actions)

```ts
export interface FlarexSocketDef { id: string; type: FlarexSocketType; required?: boolean; label: string }

export interface FlarexNodeDefinition {
  type: FlarexNodeType;
  label: string;
  inputs: FlarexSocketDef[];          // merge: bg(image,req), fg(image,req), mask(matte)
  outputs: FlarexSocketDef[];         // usually one "out"
  params: ZodSchema;                  // .strict() with defaults — same rigor as timeline actions
  keyframeable: string[];             // param keys the GraphEditor drawer may target
  lower(ctx: FlarexLowerCtx, node: FlarexNode, inputs: Record<string, FlarexValue>): FlarexValue;
}
```

### `registry.ts`

`stampFlarexRegistry(graph)` write seam + heal, beside `stampCompositionRegistry`
(same invariants: call on every graph write; heal on load).

## Part 4 — The lowering compiler (`packages/shared/src/flarex/compile-flarex.ts`)

Pure function, sibling of `buildSceneDraws`/`expandNestedCompositions`:

```ts
export interface FlarexLowerCtx {
  compWidth: number; compHeight: number;   // renderScale pre-baked (same contract as SceneGroupDraw)
  timeSeconds: number;
  hostSourceDraw: SceneLayerDraw;          // the host clip's normal graded draw
  sampleParam(nodeId: string, key: string, fallback: number): number;   // keyframe-aware
  rasterizeMask(node: FlarexNode): { tex: TexImageSource; version: number }; // SceneMaskMatteCache
}
export type FlarexValue =
  | { kind: "image"; draw: SceneDraw }
  | { kind: "matte"; tex: TexImageSource; version: number }
  | { kind: "number"; value: number };

export function compileFlarexComp(comp: FlarexComp, ctx: FlarexLowerCtx): SceneDraw;
```

Algorithm: find `mediaOut`, memoized backwards DFS (topological), each node's `lower()` maps
input values → output. Cycles rejected at edge-add time in the UI and defensively at compile
time (return host draw + diagnostic). Deterministic: same comp+ctx → structurally identical
`SceneDraw` → parity across the 3 renderers by construction.

Node → primitive mapping:
- **MediaIn** → `ctx.hostSourceDraw`.
- **Merge(bg,fg)** → `SceneGroupDraw{ children:[bg, fg±blend/opacity on shell], shell:identity }` — in-shader 16-mode blend does the work.
- **Transform** → wrap input in a `SceneGroupDraw` whose shell carries x/y/scale/rotation/anchor.
- **Color nodes** → wrap in group with `pipeline: ColorPipeline` (the shipped grade-the-nest path; LUT cached per nodeId).
- **Blur/Glow** → `blurPx`/`glow` on the wrapping shell.
- **Filter/Sharpen/ChromaKey/LumaKey** → append `SceneFragmentPass` to the shell (`chromaKey`/`lumaKey` = **new fragment builtins** with real spill suppression + edge softness — shader effort, zero architectural cost).
- **Shape masks** → existing vector `Mask` → rasterized matte value; **MatteControl** combines via the rasterizer's add/subtract/intersect/invert/feather; applied as shell `mask` or Merge's mask input.
- **Text** → existing text rasterizer → `SceneLayerDraw`.

**Wrap-collapsing** (critical): a Transform + Blur + fragment passes fold into ONE group shell
(the shell already carries transform + blurPx + glow + fragmentPasses simultaneously). Only
Merges and order-violating chains open new nest levels — typical graphs stay ≤4 deep vs
`NEST_MAX_DEPTH=8`.

**Honest gaps + the one MVP compositor extension**:
1. Two-image fragment ops (Displace, custom merge math, choke-by-image): add
   `SceneFragmentPass.auxInputs?: Array<{draw: SceneDraw}>` — compositor pre-composes each into
   a depth-pooled RTT (identical machinery to `matteFrom`) and binds `uAux0..N`. Small,
   flag-gated, pixel-parity-tested. Unlocks a whole node family.
2. Shared subtrees render N times under lowering (correct but wasteful) — acceptable ≤~40
   nodes (soft cap + HUD warning in MVP); the v2 interpreter is the real fix.
3. Pathological Merge towers vs depth 8 → raise `NEST_MAX_DEPTH` for flarex subtrees if hit
   (pool-indexing constant, not algorithmic).

**Integration point (the whole trick)**: `packages/shared/src/scene/build-scene-draws.ts` —
when a layer has `flarexCompId`, its normal draw becomes `ctx.hostSourceDraw` and the compiled
subtree replaces it. Because all 3 renderers call `buildSceneDraws`, the Edit-page preview,
local export, and Remotion all render Flarex output automatically. Per-layer memo key gains
`(flarexCompId, comp.version)`.

Export manifest: `packages/render-templates/src/index.ts` `buildRenderManifest` carries
`flarexComps` + `flarexCompId` verbatim (verify no allowlist strips them). Binary node inputs
(AI mattes) resolve to durable URIs via the existing `matte-resolve.ts` / `ensureExportReady`
gate.

## Part 5 — UI (`apps/web/src/editor/flarex/`, all new)

**Page switcher**: slim top bar (Edit | Flarex), Resolve-dense dark register. EditorPage
touches are contained to exactly three points: (a) `activePage` state atom, (b) switcher
mount, (c) one `<FlarexWorkspace/>` mount passing a narrow seam
`{ projectGraph, updateGraph, selectedClipId, transport:{timeSeconds, playing, seek}, mediaResolvers }`.
Everything else lives in the new subtree — do NOT spread into the monolith.

| File | Role |
|---|---|
| `FlarexWorkspace.tsx` | Layout shell: viewer top, node canvas bottom, inspector right, toolbar; active-comp resolution; "Create comp for clip" empty state |
| `FlarexNodeCanvas.tsx` | Canvas2D DAG editor: node boxes, bezier wires, marquee, drag, socket-to-socket connect with type validation, context-menu add-node; draft→single commit (undo-friendly) |
| `flarex-canvas-model.ts` | Pure hit-testing/layout/pan-zoom math (adapts `editor/graph/graph-view.ts`) |
| `FlarexViewer.tsx` | Reuses `ScenePreviewCanvas` on a synthetic single-clip `SceneFrameSpec` whose one draw = `compileFlarexComp(...)`. **View-any-node** (Fusion view dot) = re-root the compile at that node — free with the compiler |
| `FlarexInspector.tsx` | Selected node's params generated from its Zod schema, reusing existing inspector controls + keyframe diamonds targeting `{scope:"flarexNode"}` |
| `FlarexToolbar.tsx` | Node palette grouped Fusion-style (Generator / Color / Filter / Mask / Composite) |

Keyframes: reuse the `BottomWorkspace` GraphEditor via an adapter surfacing
`FlarexComp.animations` as GraphTargets (extend the reflection in
`apps/web/src/editor/inspector/keyframeUtils.ts` for the new scope).

**Edit ↔ Flarex linking**:
- Active comp = derived from `selectedClipId` → `layer.flarexCompId`. No comp → "Create Flarex
  comp" (stamps default `mediaIn → mediaOut` + links, via one timeline action).
- Timeline clip badge (node glyph) when `flarexCompId` set; double-click → switch page. One
  conditional in the clip renderer — minimal monolith touch.
- One shared transport; FlarexViewer renders at shared `timeSeconds` clamped to the clip range.
- Every mutation bumps `comp.version` (enforced inside the `flarex.*` actions) → Edit preview
  re-lowers only the touched clip.

## Part 6 — Performance plan

- MVP rides shipped infra: the Flarex viewer IS a ScenePreviewCanvas, so `adaptive-quality`
  renderScale, source proxies, pooled depth-indexed RTTs, context governor, frame-stats HUD
  all apply unchanged. Add: force the interactive renderScale tier while a node drag or param
  slider is active (same signal as Edit-page scrub).
- `compileFlarexComp` memoized on `(comp.version, timeBucket, renderScale)`; it's cheap CPU
  (draw-list construction) even un-memoized under keyframes.
- Shader prewarm on page entry for node types present in the comp (registry lazy-compile + a
  `prewarm(effectKeys)` walk, like transition prewarm).
- v2 interpreter: per-node RTT cache keyed by content hash `(params, upstreamHashes, timeBucket)`,
  LRU capped ~256MB (≈30×1080p RGBA8), shrinking quadratically at reduced renderScale (the
  Iris Xe valve). Hot set = the MediaOut dependency path.
- Viewer stays main-thread (shared-context grading requires it); export already runs identical
  code in the OffscreenCanvas worker — no new worker work.

## Part 7 — AI integration (same principle as the Edit page)

### `packages/shared/src/flarex/node-graph-intent.ts` — cloned from `grade-intent.ts`

```ts
export const nodeGraphIntentSchema = z.object({
  ops: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("key"), kind: z.enum(["chroma","luma"]), color: z.string().optional(),
               spill: z.boolean().optional(), edgeSoftness: z.number().min(0).max(1).optional() }).strict(),
    z.object({ op: z.literal("composite"), blend: z.enum(BLEND_MODES), opacity: z.number().min(0).max(1).optional() }).strict(),
    z.object({ op: z.literal("glow"), radius: z.number(), threshold: z.number().optional() }).strict(),
    z.object({ op: z.literal("blurRegion"), shape: z.enum(["rect","ellipse"]),
               region: z.object({ x:z.number(), y:z.number(), w:z.number(), h:z.number() }), sigma: z.number() }).strict(),
    z.object({ op: z.literal("grade"), intent: gradeIntentSchema }).strict(),   // whole grade DSL as a node
    z.object({ op: z.literal("text"), content: z.string(), look: z.string().optional() }).strict(),
    z.object({ op: z.literal("transform"), x:z.number().optional(), y:z.number().optional(),
               scale:z.number().optional(), rotation:z.number().optional() }).strict(),
  ])).min(1).max(12)
}).strict();

export function compileNodeGraphIntent(intent: NodeGraphIntent, base?: FlarexComp): FlarexComp;
```

Deterministic, local, token-free: each op appends real nodes+edges between MediaIn and
MediaOut. Output = the same editable graph the user could build by hand (the grade-intent
invariant: the LLM never chooses low-level values).

### Actions + routing
- New actions in `packages/shared/src/timeline-actions/actions/` registered in `registry.ts` +
  `capability-index.ts`: `flarex.ensureComp`, `flarex.setGraph` (what the intent compiler
  emits), `flarex.addNode`, `flarex.removeNode`, `flarex.connect`, `flarex.disconnect`,
  `flarex.setNodeParam`, `flarex.setNodeEnabled`. All Zod-validated, all bump `version`, all
  flow through the PlanStep executor → undo/persistence/safety free.
- Brain (`apps/web/src/ai/brain/`): Tier-1 rules ("key out the green screen", "add glow",
  "blur his face") compile to intent ops when the Flarex page is active or the clip has a
  comp; Tier-3 fast lane gets the intent schema + few-shots; Tier-4 AgentLoop gets the
  granular `flarex.*` actions for multi-step graph surgery. Editor commands
  (`editor-commands.ts`): `openFlarexPage`, `selectFlarexNode`.
- AI matte / tracker nodes consume existing tool artifacts (`maskSequence` → `MatteRef`,
  `trackingPath` → keyframed transform) through the existing artifact-store/mask-resolver —
  both prompt-bridge and integrated adapter paths per the two-path product rule.

## Part 8 — Phased roadmap (each phase shippable + verifiable)

### Phase 0 — Contract plumbing (no UI)
Files: `packages/shared/src/flarex/{types,node-defs,registry}.ts`; `types.ts` additions
(`flarexCompId`, `flarexComps`, `"flarexNode"` scope); `packages/shared/src/index.ts` exports;
`buildRenderManifest` carry-through check.
Verify: `pnpm typecheck`; round-trip persistence test (graph → save → load → deep-equal).

### Phase 1 — MVP (the shippable Fusion core)
- Nodes: MediaIn, MediaOut, Merge, Transform, ColorCorrect, Blur, Glow, Filter (wrapping
  existing builtins: sharpen/radialBlur/directionalBlur/chromaticAberration/...), RectMask,
  EllipseMask, MatteControl, **ChromaKey** (new builtin with spill suppression + edge
  softness), Text.
- `compile-flarex.ts` with wrap-collapsing; hook in `build-scene-draws.ts` (this single hook
  gives Edit preview + both exporters Flarex output).
- `SceneFragmentPass.auxInputs` compositor extension (flag-gated per the `render-engine.ts`
  flag pattern, pixel-parity-tested including the export-worker single-context path).
- UI: PageSwitcher, FlarexWorkspace, NodeCanvas, Viewer (with view-any-node), Inspector,
  Toolbar; timeline clip badge.
- Verify: typecheck; new `render:compare:pixels`-style fixture (chroma-keyed fg merged over bg
  + glow + transform) compared across preview / local export / Remotion; manual: build
  key→merge→glow by hand, scrub Edit page, export both paths.

### Phase 1.5 — Depth
- Keyframes on node params end-to-end (inspector diamonds, GraphEditor adapter, `sampleParam`).
- LumaKey, PolygonMask/BezierMask (reuse `clip-masks` bezier + on-viewer point editing —
  **whole-shape keyframes only**, existing `pathKeyframes` model; per-point tracking is v2+).
- AI Matte node (binds `MaskSequenceArtifactData`; export gate via `matte-resolve.ts` unchanged).
- Intent DSL + `flarex.*` actions + Brain routing.
- Perf polish: prewarm, interactive renderScale forcing, HUD counters (lowered draw count,
  nest depth), soft ~40-node cap warning.
- Verify: keyframed-param pixel fixture at 3 timestamps × 3 renderers; AI e2e determinism gate
  (same prompt → intent → graph → identical manifest hash on repeat).

### Phase 2 — Pro
- `renderNodeGraphInto` interpreter + dirty-node RTT cache + VRAM LRU; lowering path retained
  as the parity reference; per-node thumbnails on the canvas from cached RTTs.
- Multi-clip MediaIn (comp clips: `sourceClipId` param; `build-scene-draws` supplies sibling
  clips' graded draws in `FlarexLowerCtx`), Tracker node (existing local-tracking +
  `track-fusion.ts` smoothing → keyframed transform), Displace + custom merge operators
  (auxInputs), node-local time offsets.
- Verify: interpreter-vs-lowering pixel parity on ALL prior fixtures; 100-node synthetic comp
  ≥30fps at 0.5 scale on Iris Xe-class.

### v3+ ambitions (documented, not committed)
2.5D cards + camera, GPU particles-lite, paint/clone, per-point tracked roto, planar tracker.

## Part 9 — Risks

1. **EditorPage monolith**: contained by the 3-touch-point seam rule; if transport isn't
   cleanly liftable, FlarexWorkspace subscribes to the store/ref the timeline already uses —
   do not refactor the monolith.
2. **Nest depth / duplicated subtrees (MVP)**: wrap-collapsing + soft node cap + HUD warning;
   v2 interpreter is the real fix.
3. **VRAM on integrated GPUs**: renderScale is the main valve; land the LRU budget before
   per-node caches ship.
4. **Roto scope creep**: Phase 1.5 = bezier masks with whole-shape keyframes only.
5. **auxInputs parity**: flag-gated, export-worker parity check before default-on.
6. **Keyer quality**: real spill suppression + edge softness in the GLSL from day one.

## Verification (overall)
- `pnpm typecheck` per package; `pnpm --filter @orreris/worker render:compare:pixels` with new
  Flarex fixtures each phase; `render:manifest` a Flarex project → inspect frames; manual
  scenario per phase in Chrome (this box can run browser pixel gates); HUD frame budget check
  while dragging node params during playback.
- `architecture.md` + `project-tracker/` updated when each phase ships (repo convention).
