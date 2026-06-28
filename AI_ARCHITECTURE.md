# Lumio — AI Operating System Architecture & Phase Tracker

> **What this file is:** the *what-phase-are-we-in* roadmap for Lumio's AI. It tracks every phase with a live status, maps shipped work to where it lives, and records the open gaps (including the 50-prompt acceptance findings) as a bug ledger.
>
> **Sibling docs (don't duplicate):** [`AI_FEATURE_MAP.md`](AI_FEATURE_MAP.md) is the *where-things-live* file index — read it before touching the AI chat. [`architecture.md`](architecture.md) is the shipped/deferred product log. [`AGENTS.md`](AGENTS.md) is the live multi-agent handoff log.

---

## Philosophy (unchanged)

Lumio is **a professional video editor with an AI operating system on top** — not an "AI video generator." The editor is fully usable without AI; the AI *operates the editor's tools*. The relationship is always:

```
User → Lumio AI → Editor Tools → Timeline / Layers / Effects
```

never `User → AI → Final Video`. **Every AI action is editable and undoable.** The AI must think, inspect, plan, ask clarifying questions, execute, show progress, and explain — never silently make important assumptions, never run destructive actions automatically.

**Golden rules (enforced in code):** AI mutates only via the **Timeline Action Registry**; every LLM/NLU step is **registry + param validated** client-side before it can run; **the renderer is never touched** by AI work; keys stay server-side (except per-request BYO). `pnpm -r typecheck` is the lint.

---

## Legend

✅ Shipped · 🚧 In progress · 🔜 Next · 🧭 Planned (exploratory, not scheduled)

## Phase tracker

| # | Phase | Status | Lives in |
|---|-------|--------|----------|
| 1 | Editor Foundation (timeline / layers / inspector / keyframes / export) | ✅ | `apps/web` editor |
| 2 | Tool Registry | ✅ | `packages/shared/src/tools.ts` |
| 3 | Effects Registry | ✅ · 🚧 maturity (**Color system 🚧 — see [`COLOR_SYSTEM_PLAN.md`](COLOR_SYSTEM_PLAN.md)**) | `packages/shared/src/effects.ts`, `packages/shared/src/color/` |
| 4 | Timeline Action Registry (the mutation layer) | ✅ | `packages/shared/src/timeline-actions/` |
| 5 | Capability Index + param grammar | ✅ | `packages/shared/src/capability-index.ts` |
| 6 | Planning Engine (deterministic NLU + LLM gateway) | ✅ · 🚧 accuracy | `apps/web/src/ai/planner/`, `apps/api/.../aiGateway` |
| 7 | Execution Engine + undo | ✅ | `apps/web/src/ai/executor/` |
| 8 | Conversation Layer (chat, clarify, confidence, permission, **Talk mode**) | ✅ · 🚧 UX | `apps/web/src/components/ai/` |
| 9 | **Planner Accuracy & Safety Hardening** | 🚧 | this doc → Phase 9 |
| 10 | Intent Continuity (follow-up vs new request) | ✅ | `apps/web/src/ai/planner/intent-continuity.ts` |
| 11 | Memory OS (Session / Project / Creator / Style) | 🚧 (Creator+Project shipped) | `MemoryFact` (Prisma) + `apps/web/src/ai/memory*.ts` |
| 12 | Reference-driven editing (image input shipped; style fingerprint ahead) | 🚧 | multimodal gateway + `ai/talk.ts` |
| 13 | Tool Registry Expansion (the moat) | 🧭 | `tools.ts` + adapters |
| 14 | Agentic loop (feed action/tool results back to planner) | 🧭 | `apps/web/src/ai/planner/` |
| 15 | Memory Panel UI + trust controls | ✅ | `apps/web/src/components/ai/MemoryPanel.tsx` |
| 16 | AI Cost & Scaling (multi-user capacity) | 🔜 (degradation+nudge shipped) | gateway + `ai.routes.ts` + BYO |

---

## Phases 1–8 — Shipped foundation (with known gaps)

These exist and work today; see `AI_FEATURE_MAP.md` for exact files. The gaps below are why several carry 🚧.

- **1. Editor Foundation** ✅ — timeline, tracks, layers, inspector, keyframes (V2 evaluator), web preview, Remotion export. Every system works manually and exposes metadata the AI consumes.
- **2. Tool Registry** ✅ — `toolCapabilityDefinitions`: each tool declares slug/name/`aiDescription`/adapters/credits. *Gap:* several tools are mock/immature (see Phase 13).
- **3. Effects Registry** ✅ · 🚧 — schema-driven effect params drive both editor controls and renderers. *Gap (maturity):* color grade is a single preset, blur ignores "subtle"/"strong" nuance, no curves/wheels/LUT. **A full Premiere-grade color system is now planned + in progress — see [`COLOR_SYSTEM_PLAN.md`](COLOR_SYSTEM_PLAN.md)** (shared `color/` engine compiling effects → one transform emitted as SVG filter primitives for the DOM renderers + a CPU reference, WebGL/3D-LUT for the advanced phases; sub-phases 13C.0–13C.6). This is the one place AI work is *authorized* to touch the renderers (it's Phase-3 foundation, not AI-planner work); the AI planner gains the new params at 13C.6.
- **4. Timeline Action Registry** ✅ — ~24 Zod-validated, reversible actions; the **only** path AI mutates the timeline. `addShape`, `addText`/`updateText` (now incl. bold/italic + spatial x/y), `addEffect`/`removeEffect`/`updateEffect`, `addTransition`/`removeTransition` (now additive), `moveLayer`, `deleteLayer`, masks, keyframes, …
- **5. Capability Index** ✅ — `describeForPlanner()` emits the tool/effect/action grammar the planner reads (Zod-reflected `field:type(constraints)` + an INTENT-NOTES disambiguation block); `validateActionParams()` param-checks each step.
- **6. Planning Engine** ✅ · 🚧 — two tiers: the **LLM planner** (streaming multi-provider gateway, validated + one bounded repair pass) over a **deterministic wink-NLU floor** (offline, zero-key, verb-family-first). *Gap (accuracy):* the 50-prompt pass — see the Bug Ledger.
- **7. Execution Engine** ✅ — `executePlan` runs validated steps through the registry, each committed as a normal snapshot-undo; tool steps open the real tool modal; clarify steps pause for the user.
- **8. Conversation Layer** ✅ · 🚧 — chat panel with planning→review→execute phases, live thinking log, confidence, permission modes, BYO key, in-panel undo. *Gap (UX):* per-step apply (now landing in Phase 9), terminology clarity, verbose banners.

---

## Phase 9 — Planner Accuracy & Safety Hardening 🚧

The fixes from the 50-prompt acceptance pass. Status reflects this batch.

- [x] **Additive fades** — `addTransition` only replaces keyframes for the *same* direction, so fade-in and fade-out coexist; "fade in and fade out" applies both. ([transition.ts](packages/shared/src/timeline-actions/actions/transition.ts))
- [x] **Bold / italic text** — `addText`/`updateText` gained `bold`/`italic` params → mapped to `fontWeight`/`italic` (renderer already reads them); detected via `extractTextStyle` on both planner paths. ([text.ts](packages/shared/src/timeline-actions/actions/text.ts), [entities.ts](apps/web/src/ai/planner/entities.ts))
- [x] **On-frame placement** — new text/shape centres are clamped to a 22–78 % safe area so "top left" / "bottom" boxes no longer clip off-frame. ([shared.ts](packages/shared/src/timeline-actions/actions/shared.ts))
- [x] **Spatial reposition** — `updateText` gained `x`/`y` → `transform.position`; the planner routes "put the selected text in the center" to a move, not a stray new layer. ([layer/text actions], [DeterministicPlanner.ts](apps/web/src/ai/planner/DeterministicPlanner.ts))
- [x] **Remove-effect & target taxonomy** — "remove the blur" resolves the effect on the carrier layer → `removeEffect{layerId, effectId}`; "remove the fade" → `removeTransition`; a vague "delete this" on a **media clip** asks instead of deleting. ([DeterministicPlanner.ts](apps/web/src/ai/planner/DeterministicPlanner.ts), grammar in [capability-index.ts](packages/shared/src/capability-index.ts))
- [x] **Truncated-clarify salvage + safety** — completion budget raised to 4096; `extractJson` recovers a clarify question from truncated JSON instead of returning null (which previously let a destructive deterministic guess delete the user's clip). ([ai.routes.ts](apps/api/src/routes/ai.routes.ts), [aiGateway.service.ts](apps/api/src/services/aiGateway.service.ts))
- [x] **Per-step apply** — `PlanReviewCard` shows a checkbox per runnable step; the user applies a subset of a multi-step plan. ([PlanReviewCard.tsx](apps/web/src/components/ai/PlanReviewCard.tsx))
- [x] **Banner trim** — "Effect applied · track saved" replaces the long inspector sentence.
- [ ] **Shape geometry on the live LLM path** — geometry override is wired and the math is aspect-correct; re-verify once with keys set (earlier failures coincided with an exhausted provider pool).

**Deferred from this batch (tracked, not done):** Remove-Background runner registration (#27/#28/#30) and a professional person-removal tool → Phase 13. "Start 2s later" clip-offset / start-time intent (#41) → small follow-up. Caption-label styling (#14) → Phase 13. Effect maturity / "subtle" nuance (#32–#35) → Phase 13.

---

## Phase 10 — Intent Continuity ✅

A lightweight, synchronous pre-classifier ([`intent-continuity.ts`](apps/web/src/ai/planner/intent-continuity.ts)) deciding, per message, whether it **continues the last request** or **starts a new one**, *before* planning — and gating what context is threaded.

- **Continue** signals: pronouns/deixis ("it", "this", "that"), delta phrases ("bigger", "more", "the same but"), leading connectives ("also", "now", "instead"), or an explicit selection with no new object. → `lastAction` (the prior target) is threaded; the LLM gets an `Intent: CONTINUES…` steer; the chat shows "↪ continuing your last edit".
- **New** signals (override recency): a fresh object marker — shape kind, content marker (quote/"saying"), tool noun (captions/track/background), or "add/create a/new <noun>". → `lastAction` is withheld; the LLM gets `Intent: NEW…`; the deterministic floor won't resolve onto an unrelated recent layer. Ties default to **new** (never silently edit the wrong thing).

Gates today's only implicit tier (`lastAction`); Phase 11 will gate the Project/Creator/Style tiers off the same `intentScope`. Verified by `continuity:test` (14 cases). **Acceptance met:** "add a red circle" → "make it bigger" edits the circle; "add captions" → "add a blue box" creates a box, not an edit of the captions; an explicit selection always wins.

---

## Phase 11 — Memory OS (4 tiers, scalable hybrid) 🚧 — Creator + Project shipped

**Shipped this slice:** a single flexible `MemoryFact` table (Prisma; scope=creator|project|style, key/value/`confidence`/`source`/`lastUsedAt`), an auth-gated `/api/memory` (GET/PUT/DELETE) with a server-side **confidence merge** (re-observation compounds toward 1; explicit pins ≥0.9), and a **client-first** store ([`ai/memory.ts`](apps/web/src/ai/memory.ts) — localStorage is the offline source of truth, server syncs when authed; legacy `AiMemoryPreferences` migrated in, `loadMemory`/`rememberPreferences` kept as adapters). A **Memory Extractor** ([`ai/memory-extractor.ts`](apps/web/src/ai/memory-extractor.ts)) distils reusable creator+project facts from each *applied* plan (text color, color grade, captions usage, quality mode); a **bounded Retriever** ([`ai/memory-retriever.ts`](apps/web/src/ai/memory-retriever.ts)) injects a small high-confidence slice (project overrides creator) into both planners — a `Memory:` steer for the LLM, defaults for the deterministic floor. `AiChatPanel` hydrates on mount and extracts after apply, project-scoped via `projectId`. Verified by `memory:test`. **Deferred:** Style fingerprints (Phase 12). _(Memory Panel UI + low-confidence "save as default?" prompts now shipped — Phase 15.)_

Original tier design (target):

**Chosen architecture:** ephemeral memory stays client-side for zero-latency and privacy; durable memory is server-backed (Prisma/Postgres on the existing api layer) for cross-device sync, the "learn my style" workflow, and multi-user/suite scalability. It graduates from a client-first MVP to server sync **without changing the retrieval contract**.

| Tier | Scope | Store | Holds |
|------|-------|-------|-------|
| Session (working) | this chat | client (`ai/memory.ts` / component state) | current goal, selected clip, last AI action, recent corrections — dies with the session |
| Project | one video project | client cache + **Prisma** | theme, preferred caption style, music mood, do-not-use list, approved reference |
| Creator | the user, long-term | **Prisma** | default caption style, language, preferred video style, avoids |
| Style fingerprints | per reference upload | **Prisma** | pacing, avg shot length, color mood, text style, transitions, music energy → mapped to Lumio tool actions |

**Cross-cutting rules:**
- **Never send all memory to the model.** A *Memory Extractor* classifies + stores only reusable signals; a *retriever* injects a **small** relevant slice — mirroring the existing bounded `summarizeContext()` cost rule.
- Every memory carries `confidence`, `source`, `last_used`, `scope`. Low-confidence facts prompt *"Save this as your default?"* rather than being assumed.
- The "learn my style" workflow: after N edits, surface the inferred profile and offer to save it as the creator default.

---

## Phase 12 — Reference-driven editing 🚧 — image input shipped

**Shipped groundwork (multimodal):** the chat composer accepts a **reference image** (📎, downscaled client-side to a ≤1024px JPEG data URL). The gateway is now multimodal — `ProviderConfig.supportsVision`, OpenAI `image_url` content parts, and a `needsVision` filter that **routes image requests to a vision-capable provider** (Gemini in the free pool; premium Claude / BYO). Both `/ai/plan/stream` and `/ai/chat/stream` accept `images`; if no vision provider is available the user gets a clear "needs a vision model" note (image never blocks the text paths). Reference images flow through `PlannerContext.referenceImages`.

**Still ahead (the full vision):** upload a reference *video*, extract a **style fingerprint** (Phase 11 `style` scope), and **map** it onto Lumio tools as an editable plan. **Hard dependency:** only as strong as the tool coverage in Phase 13.

### Talk mode (Conversation layer, Phase 8)
A 4th permission mode — **Talk** — for inspiration: a prompt streams a conversational reply from `/ai/chat/stream` (a "creative consultant" — no plan, no registry mutation) and ends with runnable **suggestion chips** that one-tap switch to Professional and execute. Memory-aware and image-aware. Lives in [`ai/talk.ts`](apps/web/src/ai/talk.ts) + `AiChatPanel`.

---

## Phase 13 — Tool Registry Expansion (the moat) 🧭

The honest gate: **AI can only do what exists.** With a rich tool registry the planning layer becomes powerful; without it even the best model can't produce professional edits. The durable moat is *timeline-aware AI + capability registry + planning layer + editable execution + reference-driven editing* — not the model. Candidate tools to build (checklist):

- [ ] Professional Person / Background Removal (replace the immature stand-in)
- [ ] Scene Detection
- [ ] Speed Ramp
- [ ] Auto-Reframe
- [ ] Audio Ducking
- [ ] Motion Blur
- [ ] Mature Color (curves, wheels, LUTs, skin-tone-safe grades)
- [ ] Nuanced / intensity-aware Blur
- [ ] Register runners for tools whose modals open but can't yet run (e.g. Remove Background)

---

## Phase 14 — Agentic loop 🧭

Feed tool/action **results** back into the planner for multi-turn replanning (today: one-shot plan → execute). Enables "inspect → act → observe → refine" instead of a single pass.

## Phase 15 — Memory Panel UI + trust ✅

A surface where the user sees exactly what Lumio remembers, with **Edit / Forget / Use-for-this-project-only** — makes memory feel professional, not creepy. Shipped as [`MemoryPanel.tsx`](apps/web/src/components/ai/MemoryPanel.tsx) (a full-panel sibling opened from a `Brain` header icon in `AiChatPanel`, mirroring the Insights/BYO panels). Groups facts into **This project** (project-scoped) and **About you** (creator), filtering out `style` scope (Phase 12). Each fact shows a human label, value, a Pinned/Learned source badge, and a confidence meter; **Edit** pins an explicit value, **Forget** removes it, **This project only** copies a creator default down to the active project (the retriever already prefers project on a key collision). Low-confidence inferred facts (below the retriever's 0.45 steer threshold) surface as a **"Lumio noticed… save as your default?"** nudge rather than being silently assumed — the missing trust piece from Phase 11. Pure client, zero AI cost; reuses `memory.ts` (`loadFacts`/`rememberFact`/`forgetFact`) with no new store API. **Deferred:** style-fingerprint facts (Phase 12) once those exist; the panel renders them automatically when added.

---

## Bug Ledger — 50-prompt acceptance pass

Status as of Phase 9. ✅ pass · ❌ fail · 🆕 fixed this batch (re-test) · 🔜/🧭 deferred to a later phase.

| # | Prompt | Before | Now |
|---|--------|--------|-----|
| Shapes | add red circle / neutral orange shape / blue box top / small black square center / green rect bottom-right / `#ff00aa` pill | ✅ | ✅ |
| 6 | vertical `#ff00aa` pill | ❌ added horizontal | 🆕 orientation in `resolveShapeGeometry` (re-test) |
| 7–8 | big / tiny yellow circle | ❌ pill, no size | 🆕 geometry authoritative + size scale (re-test) |
| 9–13 | add text / WARNING / bottom-center / large white SUBSCRIBE | ✅ | ✅ |
| 10 / 10.1 | bold red SALE / italic SALE | ❌ no bold/italic | 🆕 bold/italic params + detection |
| 12 / 15 | "50% OFF" top-left / "hello" bottom | ❌ off-frame | 🆕 safe-area clamp |
| 14 | caption label LIVE | ❌ | 🧭 Phase 13 (caption-label styling) |
| 16–22 | bigger / smaller / recolor / dramatic / rename / huge | ✅ | ✅ |
| 16b | put selected text to center | ❌ | 🆕 `updateText` x/y move |
| 23–26 | captions / subtitles / transcribe / usual style | ✅ | ✅ |
| 27–28,30 | remove/cut background | ❌ runner not registered | 🧭 Phase 13 |
| 29 | remove the person | ⚠️ immature tool | 🧭 Phase 13 |
| 31 | remove the blur | ❌ couldn't remove | 🆕 `removeEffect` by type |
| 32–35 | cinematic / color grade / moody / subtle blur | ⚠️ shallow | 🧭 Phase 13 (effect maturity) |
| 36–37 | track + follow text | ✅ (⚠️ forces extract first) | 🔜 selectable sub-steps (per-step apply helps) |
| 38 | fade in | ✅ | ✅ |
| 39 | fade out | ❌ removed fade-in | 🆕 additive fades |
| 40 | fade in **and** fade out | ❌ only one | 🆕 additive fades |
| 41 | start two seconds later | ❌ asked to clarify | 🔜 start-time intent |
| 42 | delay selected layer 3s | ✅ | ✅ |
| 43 | delete this layer | ❌ nuked the clip | 🆕 media-clip clarify guard |
| 44 | remove selected layer | ✅ (deletes selected) | ✅ |
| 45 | delete the text | ✅ | ✅ |
| 46–48 | compound (captions+cinematic / circle+fade / bold text+blur) | ⚠️ untested | 🔜 verify + per-step apply |
| 49–50 | "make it pop" / "do something cool" | should clarify | ✅ clarify |

---

## Phase 16 — AI Cost & Scaling (multi-user capacity) 🔜

**The problem.** The shared free-tier provider keys (Cerebras/Groq/OpenRouter/Gemini) are rate-limited **per account, not per user** — so a real userbase collectively trips 429/503 in seconds, the cooldowns cycle through an exhausted pool, and everyone gets degraded results. Shared free keys are a *demo convenience, not production capacity*; they also expose the owner to cost/abuse. No client-side rate limit fixes an upstream quota.

**Constraint (`CLAUDE.md`).** Pricing/credits are **metadata only** today — *no subscription gating, no hard credit blockers, no enforcement*, results must always stay editable. So the enforcement pieces below are **planned, not built**; they only ship if/when that rule is intentionally lifted.

**Tiered model (target):**
1. **Deterministic floor (✅ shipped).** Offline, zero-key, instant — the always-available base. Core editing never depends on the pool.
2. **BYO key (✅ shipped, the free-to-operate scaling path).** Each user runs on *their own* provider quota → zero load/cost on the owner. Should become the default nudge for free users.
3. **Graceful degradation + BYO/Pro nudge (✅ shipped this slice).** When the shared pool is exhausted, the planner transparently falls back to the deterministic floor **and surfaces a note** ("planned offline — shared AI pool busy; add your key 🔑 or turn on Pro"); Talk mode shows an honest "couldn't reach a model" message instead of an empty reply.
4. **Paid pooled keys + per-user limits (🧭 deferred — needs the no-enforcement rule lifted).** Move the shared pool to paid tiers (far higher RPM), **auth-gate the AI routes**, apply **per-user rate limits + quotas**, and **meter usage against the existing wallet/credits** — Free → BYO/deterministic, Paid → pooled paid keys metered by credits. Requires auth on `/api/ai/*` (currently public + per-IP 12/min) **without breaking the unauthenticated demo/local flow** (BYO + deterministic must stay keyless).

**Honest takeaway:** treat the shared free pool as a demo. Real capacity = BYO (offload) + the deterministic floor (free tier) + paid pooled keys behind auth/quotas/credits (monetized tier).

## AI safety (always)

AI must never, without confirmation: delete user content, overwrite/replace media, run destructive actions automatically, or export. A malformed/empty model reply must **never** fall through to a destructive guess (enforced via clarify salvage + the media-clip delete guard in Phase 9).
