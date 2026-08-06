# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install
cp .env.example .env && docker compose up -d   # Postgres + Redis
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev                # runs api + web + worker together (web :5173, api :4100)
pnpm typecheck           # pnpm -r typecheck (tsc --noEmit per package; this IS the lint step)
pnpm lint                # same as typecheck (no eslint in this repo)
pnpm build               # pnpm -r build
```

Demo login: `demo@pesamee.studio` / `password123`

Single-package commands (prefer these over the root `-r` scripts when iterating on one app):

```bash
pnpm --filter @orreris/web typecheck
pnpm --filter @orreris/worker typecheck
```

Worker-side test/QA scripts (no test framework - these are standalone tsx scripts that assert and exit non-zero on failure):

```bash
pnpm --filter @orreris/worker animation:test          # keyframe/animation evaluator
pnpm --filter @orreris/worker caption:qa               # caption pipeline QA
pnpm --filter @orreris/worker render:compare            # Remotion vs web preview comparison
pnpm --filter @orreris/worker render:compare:pixels     # pixel-diff version of the above
pnpm --filter @orreris/worker render:manifest <file>    # render a manifest JSON through the real Remotion renderer to an mp4, for manual verification
```

There is no per-test filtering - these scripts run a fixed scenario end to end. When verifying a renderer change, prefer `render:manifest` against a real manifest and inspect output frames over trusting typecheck alone.

## Architecture

**Render manifest is the product contract.** Every consumer (web preview, Remotion export, future local/cloud render) must consume the same deterministic `TimelineComposition` data so they stay pixel-aligned. When changing how something renders, the change must land in both `apps/web/src/components/VideoPreview.tsx` (web canvas/DOM preview) and `apps/worker/src/remotion/Root.tsx` (Remotion renderer) - never one without the other. The repo has been bitten by this before: a renderer-only `entranceScale()` spring caused exports to zoom-in while the editor preview stayed flat. Use `pnpm render:compare:pixels` to catch this class of bug.

**`packages/shared` owns the product vocabulary** and is imported by web, api, and worker:
- `types.ts` - `TimelineComposition`/`TimelineTrack`/`TimelineLayer`/`TimelineEffect`/keyframe types, `ModuleType` union (`PERSON_EXTRACTION`, `TEXT_BEHIND_PERSON`, `SMART_3D_FOLLOW_TEXT`, `AUTO_CAPTIONS`, `BACKGROUND_REMOVAL`, `FINAL_RENDER`, ...)
- `tools.ts` - `toolCapabilityDefinitions`: the registry of AI tools (Auto Captions, Extract Person, Remove Background, Smart 3D Follow Text, Text Behind Person), each declaring accepted inputs, output artifact types, stages, browser/adapter support
- `effects.ts` - `timelineEffectRegistry`: schema-driven effect param definitions consumed by both the editor controls and the renderers
- `masks.ts` - person-extraction artifact shapes (`MaskSequenceArtifactData`, `SubjectBounds`, `TrackingPathArtifactData`) and composition builders for mask-driven templates
- `captions.ts` / `composition-style.ts` - caption track + rich-text style pipeline shared by editor, web preview, and Remotion
- `templates.ts` / `dependencies.ts` - templates are reusable module stacks, not fixed videos; the dependency resolver auto-inserts prerequisite modules (e.g. adding `SMART_3D_FOLLOW_TEXT` pulls in `PERSON_EXTRACTION`/tracking)
- `animation.ts` - the keyframe interpolation evaluator shared by editor, web preview, and Remotion

**Two usage paths every AI tool must support** (see `architecture.md` for full detail): a free "prompt bridge" path where Orreris generates a prompt the user pastes into their own chat AI and pastes the result back in, and an integrated path where Orreris calls the adapter directly. Both paths produce the same editable timeline data through the same tool capability registry - don't build a tool that only works one way.

**Tool adapter system** (`apps/web/src/tools/`): each AI tool capability runs through one of four adapter types - `mock` (schema-compatible fake artifacts, fast, used for UI/product flows), `browser` (real local computation, gated by `apps/web/src/tools/capabilities.ts` feature detection: WebWorkers/OffscreenCanvas/WebCodecs/WebGPU/OPFS/SharedArrayBuffer), `cloud` (contract-only stub today, queues toward a future real service), `desktop` (planned, not implemented). `tool-runner.ts` picks/dispatches the adapter; `artifact-store.ts` persists generated artifacts to OPFS with an in-memory fallback. `local-transcription.ts` (lazy-loaded `@huggingface/transformers` pipeline, cached, cancellable, progress-reporting) is the reference pattern for any new browser-side ML tool.

**Pricing/credits are metadata only right now** - no subscription gating, no hard credit blockers, results must always remain editable timeline data regardless of which adapter produced them. Don't add enforcement.

**App layout**: `apps/web` (React/Vite editor + tool pages), `apps/api` (Express + Prisma/Postgres, JWT auth, routes for auth/templates/tools/assets/projects/jobs/payments), `apps/worker` (Remotion render pipeline + BullMQ queue, defaults to inline execution unless `WORKER_QUEUE=bullmq`), `packages/render-templates` (render-template placeholder logic), `packages/shared` (above).

**Currently mocked, not real**: video upload metadata inspection, person extraction masks/cutouts, motion tracking, payment gateway (mock provider behind `apps/api/src/services/payment.service.ts`), `apps/api/src/services/mockProcessing.service.ts` (stands in for the real Remotion/FFmpeg pipeline at the API layer - the actual worker-side Remotion renderer in `apps/worker/src/remotion/` is real), `apps/api/src/services/aiPlanner.service.ts` (keyword-matching stand-in for an LLM-backed planner).

## Coordination

**Engine architecture now lives in a different repository** (2026-08-06). Read `ARCHITECTURE_SOURCE_OF_TRUTH.md` before writing any architecture document here. Short version: this repo is the shipping web product (features, UX, revenue); `C:\Users\rosha\Documents\orreris` is the native engine repo and owns engine laws, ADRs, and the rendering/scheduling architecture. Existing engine `.md` files here (ORIS_*, ORRERIS_OS, FLAREX_*, PREVIEW_PIPELINE, PLUGIN_ARCHITECTURE, NLE_ANALYSIS, …) are **frozen historical design records** - don't rewrite them to match later decisions. `architecture.md`, `project-tracker/`, and product/UX docs stay live here.

`AGENTS.md` is **retired** (2026-07-14) - do not read or update it; it's a stale multi-agent handoff log kept only for history. `architecture.md` is the product/feature tracker (shipped vs deferred vs next) - update it when you ship or defer something, don't duplicate its content here. Recurring problem/solution logs live in `project-tracker/` (append-only, versioned per category).
