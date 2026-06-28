# Lumio AI — Feature Map (context primer for new chats)

Paste this file (or point the assistant at it) before working on the AI chat feature, so it doesn't re-scan the codebase. It is the single source of truth for *where things live*; read the named files for detail. Vision/spec lives in `AI_ARCHITECTURE.md`; phased history in `architecture.md` → "Lumio AI Operating System"; live handoff log in `AGENTS.md`.

## Golden rules (don't break these)
- **Timeline Action Registry is the ONLY way AI mutates the timeline.** AI never edits `TimelineLayer`/`TimelineComposition`/effects/keyframes directly. Actions wrap existing pure ops; they're validated + reversible.
- **AI only *selects* registered capabilities.** Every LLM-returned step is validated against the live registries client-side before it can run. Unknown tool/action → dropped.
- **Never touch the renderer.** No changes to `apps/web/src/components/VideoPreview.tsx` or `apps/worker/src/remotion/Root.tsx`. Verify with `pnpm --filter @reelforge/worker render:compare:pixels` (must stay ~0.245%).
- **Everything stays editable + undoable.** Each applied step commits through the editor's normal `updateComposition` snapshot-undo.
- **Keys stay server-side** (except BYO, which is per-request and never persisted/logged).
- TS strict; `pnpm -r typecheck` IS the lint. Tests: `pnpm --filter @reelforge/shared actions:test`, `pnpm --filter @reelforge/web editor:test`.

## Data flow (one request)
```
AiChatPanel.handleSubmit(prompt)
  → buildContext() (composition + selection + nowSeconds + history + lastAction + memory)
  → createPlanner().plan(prompt, ctx, onEvent)        // ai/planner/createPlanner.ts
     → LlmPlanner: POST /api/ai/plan/stream (NDJSON, streaming)   // falls back ↓
        → aiGateway: provider pool failover → provider SSE → reasoning+answer
     → validateSteps() against buildCapabilityIndex()  // drop anything unregistered
     → AiPlan { steps, confidence, confidencePercent, reasoning, provider, notes }
     (any failure → DeterministicPlanner — offline, free, always works)
  → shouldAutoApply()? (permission mode + confidence) → auto-run : show PlanReviewCard
  → executePlan(plan, deps)                            // ai/executor/PlanExecutor.ts
     → timelineAction steps → timelineActionRegistry.execute → commitComposition (undo)
     → tool steps → openTool()=openToolForAi → real tool modal, pauses on requiresInput
     → clarify steps → askClarify() → pause, ask in chat, resume on user reply
```

## File index

### Shared domain (`packages/shared/src/`)
- `timeline-actions/` — **the mutation layer.** `registry.ts` (singleton `timelineActionRegistry`, `.execute(id, params, ctx, {ai})`), `types.ts`, `validation.ts`, `patches.ts` (immer), `analytics.ts` (counters + `logUnsupported` + subscribe/hydrate), `actions/{text,layer,clip,effect,keyframe,transition,track,mask,shared,index}.ts` (~24 actions). **Add a new AI-driveable edit here.**
- `capability-index.ts` — `buildCapabilityIndex()` → `{ findTool, findEffect, hasAction, listActionIds, describeForPlanner() }`; `classifyToolCost()` (browser=free/cloud=credits), `actionCost()`, `CostEstimate`. `describeForPlanner()` is what the LLM sees as "CAPABILITIES".
- `tools.ts` — `toolCapabilityDefinitions` (tool registry: slug/name/aiDescription/adapters/estimatedCredits). **Add a new tool here.**
- `effects.ts` — `timelineEffectRegistry` (schema-driven effect params).
- `types.ts` — `TimelineComposition`/`TimelineTrack`/`TimelineLayer`, etc.

### Web AI core (`apps/web/src/ai/`)
- `types.ts` — `PlanStep` (`kind: timelineAction|tool|clarify`), `AiPlan`, `PlannerContext` (`composition,selection,nowSeconds,history?,lastAction?,memory?`), `PlannerProvider.plan(prompt,ctx,onEvent?)`, `PlanStreamEvent` (`phase|provider|reasoning`), `PermissionMode`, `AiMemoryPreferences`, `StepProgress`.
- `planner/createPlanner.ts` — factory; `LlmPlanner` wrapping `DeterministicPlanner` fallback. `VITE_LUMIO_LLM_PLANNER=off` forces deterministic.
- `planner/DeterministicPlanner.ts` — keyword/regex planner (captions, background, follow/track, addText, colorGrade, blur, fades) + follow-up deltas ("make it bigger/smaller/more dramatic", recolor) via `updateText`. Records demand + unsupported. Always-free floor.
- `planner/LlmPlanner.ts` — streams `/api/ai/plan/stream`, dispatches `PlanStreamEvent`s, `validateSteps()` against registries, `buildPlan()` (numeric confidence→percent+label), `summarizeContext()` = **the relevant-slice cost rule** (selected + on-playhead layers, cap 12, trimmed fields). Sends `byo` + `premium`.
- `executor/PlanExecutor.ts` — `executePlan(plan, {getContext,commitComposition,openTool?,askClarify?,onProgress})`; returns `{applied,failed,skipped,targetLayerIds,durationMs}`; records exec time.
- `permission.ts` — `PERMISSION_MODES`, `shouldAutoApply(plan,mode)` (Quick=safe-free only, Agent=confident, Professional=never; `<60%` confidence blocks auto-apply).
- `confidence.ts` — `CONFIDENCE_INFO` (label→explanation), `confidenceClass()`.
- `memory.ts` — `loadMemory/rememberPreferences/clearMemory` (localStorage `AiMemoryPreferences`: captionStyle/colorGrade/qualityMode/language/permissionMode/textColor).
- `byok.ts` — `loadByoKey/saveByoKey/clearByoKey`, `BYO_PROVIDERS` (groq/cerebras/openrouter/gemini/anthropic).
- `analytics-store.ts` — `initAnalyticsPersistence()` (called in `main.tsx`), `readAnalytics()`.

### Web AI UI (`apps/web/src/components/ai/`)
- `AiChatPanel.tsx` — **the orchestrator.** Owns header (✨ AI · 🔑 BYO · 📊 insights · ✕), starter chips (`STARTER_PROMPTS`), planning→review→executing phases, mode + best-quality toggles, live `think` state, clarify pause/resume, composer. Props: `getContext, commitComposition, openTool?, onClose?`.
- `PlanReviewCard.tsx` — steps + cost + confidence (label · %) + reasoning + Apply/Modify/Cancel.
- `AiProgressList.tsx` — per-step ✓/⏳/✕ during execution.
- `AiThinkingLog.tsx` — live pipeline phases + streaming reasoning (event-driven; timer fallback).
- `AiReasoningLog.tsx` — collapsible chain-of-thought in the plan card.
- `PermissionModeSelector.tsx`, `AiInsightsDashboard.tsx` (P7), `ByoKeyPanel.tsx` (GP3), `MemoryPanel.tsx` (P15 — what Lumio remembers; Edit/Forget/"this project only" + low-confidence "save as default?" nudge; full-panel sibling via the `Brain` header icon, reads `loadFacts()`/`rememberFact`/`forgetFact`).
- Mounted in `pages/EditorPage.tsx` (`.ai-dock` aside; `openToolForAi` bridges tool steps to `SmartFollowTextEffectModal`/`ToolEffectRunnerModal` with `toolStepResolverRef`). CSS in `styles/global.css` (search `.ai-chat-panel`, `.ai-composer`, `.ai-dock`).

### API gateway (`apps/api/src/`)
- `routes/ai.routes.ts` — `POST /api/ai/plan` (JSON) + `POST /api/ai/plan/stream` (NDJSON: `{e:"provider"|"reasoning"|"answer"|"done"|"unavailable"}`). Shared `SYSTEM_PROMPT`, `planRequestSchema` (`prompt,capabilities,context?,history?,byo?,premium?`), per-IP rate limit (12/min, BYO-exempt), 60s plan cache, `buildUserContent`, `extractJson`.
- `services/aiGateway.service.ts` — `planWithGateway`/`streamPlanWithGateway(system,user,handlers?,{byo,premium})`; pool `Cerebras→Groq→OpenRouter→Gemini` + premium Claude (gated) + BYO (first); `candidatesFor()`, per-provider cooldown, `consumeSse()` (parses OpenAI SSE: `delta.content` + `delta.reasoning`/`reasoning_content` + inline `<think>`). All OpenAI-compatible `/chat/completions`.
- `config/env.ts` — `{CEREBRAS,GROQ,OPENROUTER,ANTHROPIC}_API_KEY`, `*_MODEL`, `GEMINI_API_KEY`, `GEMINI_PLANNER_MODEL`. `app.ts` mounts `aiRouter`.

## Extension recipes
- **New AI-driveable edit (no tool):** add a `TimelineActionDefinition` in `packages/shared/src/timeline-actions/actions/*` + register in `index.ts`; add to `actions:test`. It auto-appears in `describeForPlanner()` (LLM can use it). Add a regex branch in `DeterministicPlanner` for the offline path.
- **New tool step (e.g. ML tool):** add to `toolCapabilityDefinitions` (`tools.ts`); planner emits `{kind:"tool", toolSlug, requiresInput?}`; if interactive, wire it in `EditorPage.openToolForAi`.
- **New LLM provider:** add to `pool()` in `aiGateway.service.ts` + env key/model. (Must be OpenAI-compatible, or add a per-provider adapter.)
- **Better planning quality:** edit `SYSTEM_PROMPT` in `ai.routes.ts` (LLM) and/or `DeterministicPlanner` regexes (offline).
- **Richer context to the model:** extend `summarizeContext()` in `LlmPlanner.ts` (keep the slice bounded — that's the cost rule).

## Status: built (P1–P8 + GP1–GP4 + intent overhaul + Phase 9 accuracy/safety + P10 continuity + P11 memory Creator/Project)

> Phase status now lives in `AI_ARCHITECTURE.md` (phase tracker + 50-prompt Bug Ledger). Phase 13+ (Tool-registry moat) tracked there.

**Talk mode + reference image (2026-06-24):** 4th permission mode `talk` → `apps/web/src/ai/talk.ts` `streamTalk()` hits `POST /ai/chat/stream` (consultant prompt, no plan) and renders runnable suggestion chips (tap → Professional + run). Reference image: composer 📎 attach (`encodeReferenceImage` downscale) → `PlannerContext.referenceImages` → gateway multimodal `image_url`, routed to a vision provider (`supportsVision`; Gemini/premium/BYO). `gatewayHasVisionProvider()` guards with a clear note when none. Both `/ai/plan/stream` and `/ai/chat/stream` accept `images`.

**Phase 11 — Memory OS (2026-06-24, Creator+Project slice):** `MemoryFact` Prisma model + auth-gated `/api/memory` (`services/memory.service.ts`, `routes/memory.routes.ts`) with a confidence merge; client-first tiered store `apps/web/src/ai/memory.ts` (localStorage cache + sync via `lib/api.ts`), `memory-extractor.ts` (facts from applied plans), `memory-retriever.ts` `selectMemorySlice()` (bounded, project>creator) → `PlannerContext.memory`/`memoryNote`. `AiChatPanel` takes `projectId`, hydrates on mount, extracts after apply. **Run `pnpm db:migrate` (needs Postgres) before the server path works** — client works offline meanwhile. Test: `pnpm --filter @reelforge/web memory:test`.

**Phase 10 — Intent Continuity (2026-06-24):** `apps/web/src/ai/planner/intent-continuity.ts` `classifyContinuity()` runs per message before planning → `PlannerContext.intentScope`. `AiChatPanel.buildContext(prompt)` gates `lastAction` (threaded only on `continue`) + shows "↪ continuing your last edit"; `LlmPlanner.summarizeContext` emits an `Intent: CONTINUES/NEW` steer; `DeterministicPlanner.followUpTextLayer` won't fall back to the most-recent text on `new`. Test: `pnpm --filter @reelforge/web continuity:test`.

**Phase 9 batch (2026-06-24):** additive fades (`addTransition` strips only the same direction); `addText`/`updateText` bold/italic (`extractTextStyle`) + spatial `x`/`y` reposition; `clampToSafeArea()` keeps new layers on-frame; REMOVE-family taxonomy — "remove the blur" → `removeEffect`, "remove the fade" → `removeTransition`, vague media-clip delete → clarify; `extractJson` `salvageClarify` for truncated replies + `max_tokens` 4096 (closes the destructive-fallback path); per-step apply checkboxes in `PlanReviewCard` (`onApply(stepIds)`).

Registry + capability index + cost; deterministic + LLM planners; plan review/executor/undo; confidence (raw %) + clarify loop; permission modes; memory; analytics dashboard; **provider gateway** (failover pool) + reasoning log + **live SSE streaming** + **BYO-key (incl. Claude)** + gated paid Claude hop. Deterministic floor always works with zero keys.

**Intent overhaul (2026-06-24):**
- `describeForPlanner()` emits **param grammar** (Zod-reflected `field:type(constraints)` via `describeZodShape()`) + an INTENT-NOTES disambiguation block; `capability-index.ts` exposes `validateActionParams()`.
- `LlmPlanner.validateSteps` param-validates each step (not just `hasAction`); `SYSTEM_PROMPT` has few-shot examples; **one bounded agentic repair** re-sends `repair:{previous,errors}` once before deterministic fallback.
- **Deterministic planner is now an NLU engine** (`planner/nlu.ts` wraps **wink-nlp**, lazy-loaded as a separate chunk): verb-first family classification (add/edit/remove/effect/tool) decides the action family before target resolution — `addShape` etc. now covered. `VITE_LUMIO_LLM_PLANNER=off` to exercise it.
- **Server AI debug logs**: `apps/api/src/lib/logger.ts` (`aiLog`), gated by `LUMIO_AI_DEBUG=1`/`LOG_LEVEL=debug`; instruments gateway + routes failure paths (never logs keys/prompts).
- **Chat undo**: `AiChatPanel` `onUndo` prop + "Undo last edit (N)" button reverts the last applied plan's commits.

## Likely "advanced" directions for the next chat (not yet built)
- **Agentic loop:** feed tool/action *results* back into the planner for multi-turn replanning (currently one-shot plan → execute).
- **LLM tool-use / function-calling** instead of JSON-in-text (more reliable structured plans; needs provider support).
- **Streaming partial plan** (render steps as they arrive) + voice input (mic in composer).
- **Capability semantic search** for when tool/action count grows large (don't dump the whole registry).
- **AI session as one undo group**; inline before/after preview of a plan; eval harness for planner accuracy.
- **Persisted multi-project memory / preferences sync**; richer BYO (model picker per provider, usage meter).
- Redis-backed rate-limit + cache for multi-instance deploys.

---
### Paste-to-start blurb for a new chat
> Working on the Lumio AI chat feature in this repo. Read `AI_FEATURE_MAP.md` for the full layout (don't grep the codebase). Golden rules: AI mutates only via the Timeline Action Registry, every LLM step is registry-validated, never touch the renderer, everything stays undoable. I want to work on: <X>.
