# Kimera Editor — Architecture Refactor Plan

Status: **Phase 1–2 done (this doc); Phase 3 core scaffolding shipped (2026-06-23); Phase 4+ pending.** State layer chosen: **Zustand** (granular slice subscriptions — the Figma-style lever for keeping a large timeline fast). Phase 3 added the foundation *alongside* the monolith with **zero behavior change** (render diff unchanged, app runnable).

Phase 3 shipped: `apps/web/src/editor/` — `state/editorStore.ts` (zustand, mutations route through `timelineActionRegistry`, snapshot undo/redo), `registry/{modules,inspector,commands,builtins}.ts`, `performance/{previewQuality,visibleRange,renderCache,workerPool}.ts`, `editor.test.ts` (`pnpm --filter @kimera-by-aelivion/web editor:test`).

Phase 4 started (inspector slice 1): shared inspector primitive `NumberControl` extracted to `editor/inspector/controls/`; `TextWarpControls` migrated to a **registered, lazy-loaded** panel `editor/inspector/panels/TextWarpPanel.tsx` (own code-split chunk); `InspectorHost` renders registered panels for a layer type; `EditorPage` Warp section now renders via `<InspectorHost panelIds={["text.warp"]} />`. Behavior parity preserved (render diff unchanged). EditorPage trimmed 5,419 → 5,282 LOC. **Pattern proven** — remaining inspector panels (Transform/keyframe controls, Typography, Fill/stroke, Background, Shadow, Shape, plus video/person/audio panels) migrate the same way, each registering itself and dropping its manual section so `InspectorHost` becomes the single inspector.

Goal: make the editor *feel* professional and stay *lightweight in the browser* — by turning the web app from a monolith into a **shell + registries + lazy modules**, without breaking working features and keeping the app runnable after every phase.

---

## Phase 1 — Current architecture (map)

### Folder layout (`apps/web/src`)
```
pages/        EditorPage.tsx (5,419 LOC!), ToolDetailPage.tsx (2,823), Smart/RemovePerson panels, route pages
components/    TimelineStrip.tsx (2,003), VideoPreview.tsx (1,520), modals, control widgets
tools/        adapter system: tool-runner.ts, capabilities.ts, artifact-store.ts, local-*.ts (ML), layer-effect-handlers.ts, useLayerToolEffectRunner.ts
ai/           planner / executor / types (new — P1–P3 AI work)
components/ai/ chat, plan review, progress (new)
lib/          api.ts, color, trackLibrary
styles/       global.css (8,100 LOC)
```

### Domain model & registries (HEALTHY — `packages/shared`)
Already registry-driven and renderer-agnostic; this is the strong part to preserve:
- `tools.ts` → `toolCapabilityDefinitions` (tool self-description: accepts/outputs/stages/adapters/cost)
- `effects.ts` → `timelineEffectRegistry` (schema-driven params)
- `timeline-actions/` → `timelineActionRegistry` (validated, reversible mutations — new)
- `capability-index.ts`, `templates.ts`, `dependencies.ts`, `animation.ts`, `masks.ts`, `captions.ts`

### Adapter system (HEALTHY — `apps/web/src/tools`)
`tool-runner.ts` dispatches `mock | browser | cloud | desktop`; `capabilities.ts` feature-detects WebWorkers/OffscreenCanvas/WebCodecs/WebGPU/OPFS; `artifact-store.ts`/`matte-store.ts`/`inpaint-store.ts` persist to OPFS w/ memory fallback; `local-transcription/segmentation/tracking/inpainting.ts` are the real ML adapters. This already matches the "Adapter System" target reasonably well.

### State management (THE PROBLEM)
- **No store.** `EditorPage` holds **39 `useState`** + refs and **81 functions** — composition, selection, playback, undo stacks, tool-modal state, panel tabs, all inspector handlers.
- Undo = full `ProjectGraph` snapshots in `useRef` (150-deep). Works, but coarse.
- **Inspector is hardcoded**: `LayerInspector`, `TextGraphicControls`, `ShapeGraphicControls`, `BackgroundControls`, `ShadowControls`, `TextWarpControls` are all functions *inside* EditorPage.tsx, switched by `layer.type` with inline conditionals. Adding a layer type or a control means editing the monolith.
- Tool-modal wiring (`activeLayerToolEffect`, the two modal branches) lives inline in EditorPage.

### Rendering / timeline / export flow
- **Render contract**: `ProjectGraph.composition` (`TimelineComposition`) → consumed identically by `VideoPreview.tsx` (web) and `apps/worker/src/remotion/Root.tsx` (export). Style/keyframe logic shared via `packages/shared` (`composition-style.ts`, `animation.ts`). This parity is sacred (`render:compare:pixels`).
- **Preview**: `VideoPreview` renders the full composition every frame via DOM/CSS + `MaskedVideoLayer` (canvas compositing). No proxy, no visible-range culling, no render cache, no quality-mode-driven downscaling (a `previewQuality` state exists but only lightly used).
- **Timeline**: `TimelineStrip` (2,003 LOC) draws all tracks/layers/keyframes.
- **Export**: API `POST /jobs` → worker Remotion render (real); browser/local/cloud export deferred.

### Current bottlenecks
1. **EditorPage monolith** — the central scaling blocker; every feature widens it.
2. **Inspector not data-driven** — no registry; UI hardcodes per-type controls.
3. **No lazy loading** — heavy modules (ML tools already lazy-import their models, good) but effect/color/caption *UI* and panels all ship in the main bundle via the monolith.
4. **Preview renders everything, always** — no visible-range limiting, no debounced/cached frames, no proxy pipeline; large comps will stutter.
5. **No command palette / unified command bus** — keyboard handling is inline in EditorPage.

---

## Phase 2 — Proposed architecture (not over-engineered)

Principle: **strangler-fig, not rewrite.** Keep the healthy `packages/shared` registries and `tools/` adapters. Introduce a thin **shell + four web-side registries + a lazy loader**, then migrate the monolith's pieces into them one at a time. The app stays runnable after every step.

### New web structure (added alongside the monolith, filled incrementally)
```
apps/web/src/editor/
  shell/            EditorShell.tsx (layout: Toolbar | AssetLibrary | Preview | Timeline | Inspector | CommandPalette)
  state/            editorStore.ts (Zustand) — composition, selection, playback, undo; selectors + actions
  registry/
    modules.ts      ModuleRegistry — { id, name, type, lazyImport, requiredCapabilities, inspectorPanels, timelineActions, previewOverlays, commands }
    inspector.ts    InspectorRegistry — per layer-type panel providers (lazy)
    commands.ts     CommandRegistry — id, title, run(), keybinding (drives Command Palette + shortcuts)
  inspector/        InspectorHost.tsx + extracted panels (TransformPanel, TypographyPanel, MaskPanel, AudioPanel, …)
  layers/           layer-model helpers (typed accessors over TimelineLayer; NOT new classes — thin functions)
  performance/      previewQuality.ts, renderCache.ts, visibleRange.ts, workerPool.ts, proxy interfaces
```
`packages/shared` stays the domain source of truth. Effects/tools/actions registries are **re-exported into ModuleRegistry**, not duplicated.

### The Module Registry (the keystone)
Every major feature registers a descriptor (lazy):
```ts
interface EditorModule {
  id: string;                    // "captions", "color", "tracking", …
  name: string;
  type: "tool" | "effect" | "panel" | "engine";
  load: () => Promise<unknown>;  // dynamic import() — code-split
  requiredCapabilities?: (keyof BrowserToolCapabilities)[];   // reuse capabilities.ts
  inspectorPanels?: InspectorPanelProvider[];                  // contributed to InspectorRegistry
  timelineActions?: string[];                                  // ids already in timelineActionRegistry
  previewOverlays?: PreviewOverlayProvider[];                  // e.g. tracker box, motion path
  commands?: CommandDescriptor[];                              // contributed to CommandRegistry
}
```
Modules self-register; the shell never imports a feature directly. Existing tool/effect registries feed this with adapters, so no behavior is rewritten — only re-described.

### Inspector System (data-driven)
`InspectorHost` reads the selected layer's `type`, asks `InspectorRegistry` for the panel providers, and renders them with **progressive disclosure** (Basic → Advanced → Expert sections). Maps directly to your spec:
- Video → Transform, Crop, Speed, Color, Effects, Audio, AI
- Text → Typography, Animation, Stroke, Shadow
- Person → Mask, Outline, Texture, Blend, Tracking
- Audio → Volume, EQ, Noise Removal, Voice Enhance

The existing `TextGraphicControls`/`ShapeGraphicControls`/etc. are **moved out of EditorPage** into panel modules and registered — same UI, no rewrite.

### State (Zustand store)
Replace EditorPage's 39 `useState` with one `editorStore` exposing selectors + actions. Mutations route through the **Timeline Action Registry** (already built) so AI and UI share one path. Undo stays snapshot-based initially (it works); patch-based undo is a later option. This is the single biggest readability/perf win and shrinks EditorPage to a thin shell.

### Performance foundation (interfaces first, implementations incremental)
Prepare the structure without boiling the ocean:
- `previewQuality.ts` — low/med/high → resolution scale + effect fidelity (wire the existing `previewQuality` state into VideoPreview).
- `visibleRange.ts` — compute on-screen time window; preview/timeline skip off-range layers.
- `renderCache.ts` — memoize rendered frames keyed by (layer hash, time, quality); invalidate on edit.
- `workerPool.ts` — abstraction over the existing `tracking-worker.ts` pattern; OffscreenCanvas where available.
- `GpuRenderer` interface — WebGL/WebGPU abstraction with CSS/DOM fallback (today's path is the fallback).
- WebCodecs / WASM-FFmpeg **adapter interfaces** under the existing adapter system (stubs → future).
- Debounced preview render already partially present; formalize it.

### AI Command System
Fold the new AI planner/registry into `CommandRegistry`: each AI-capable action ("remove background", "text behind subject", "auto captions", "cinematic grade", "track face", "stabilize") is a `CommandDescriptor` that emits a plan of registered tools/timeline-actions — reusing everything from P1–P3. Command Palette (⌘K) lists both manual commands and AI commands.

---

## Phases 3–6 — Execution (incremental, app runnable after each)

- **Phase 3 — Core scaffolding (no behavior change).** Add `editor/registry/*` (Module/Inspector/Command), `editor/state/editorStore.ts`, `EditorShell` wrapper, performance interface stubs. EditorPage keeps working; shell wraps it.
- **Phase 4 — Migrate features into the structure.** Move inspector panels out of EditorPage into registered modules (one layer-type at a time); move tool-modal wiring into the tracking/mask modules; port state to the store slice-by-slice. Verify `render:compare:pixels` + typecheck after each move.
- **Phase 5 — Performance foundation.** Implement previewQuality wiring, visible-range culling, render cache, worker pool, proxy pipeline interface. Measure.
- **Phase 6 — Docs.** `architecture.md` (update), `module-authoring.md`, `adapter-authoring.md`, `performance-notes.md`.

### Guardrails
Keep `packages/shared` as the contract; never duplicate a registry. No renderer/manifest change without `render:compare:pixels`. No feature deleted. No feature-specific logic in shell components. Strict TS. App runnable + typecheck-clean after every phase.

---

## Deliverable answers (to be finalized in Phase 6)

- **How to add a module:** implement an `EditorModule` descriptor with a `load()` dynamic import; register it; contribute inspector panels / commands / overlays. Shell picks it up — no shell edits.
- **How to add an effect:** add a definition to `timelineEffectRegistry` (`packages/shared/effects.ts`) with its param schema + preview/export support flags; it appears in the Effects panel and is drivable by `addEffect`/`updateEffect` timeline actions automatically.
- **Remaining tech debt (today):** EditorPage monolith; ToolDetailPage (2,823 LOC) duplicates tool Apply logic; preview has no culling/cache; export browser/local/cloud paths deferred; OPFS matte URIs not yet resolvable server-side.
