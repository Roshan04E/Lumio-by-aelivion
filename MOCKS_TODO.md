# Mocks → Real Implementations (TODO)

Initiative: remove every mock from the product and replace it with a real implementation.
This file is the running plan. Payments are intentionally **excluded** (see bottom).

Convention: each item lists the **mock**, the **files**, **what it fakes**, and the **real work**
needed to remove it. Do the "fill the gap" work *before* deleting the mock — several are
load-bearing (deleting them without the real path breaks the app).

---

## ✅ Done (this pass — 2026-07-13)

- **AI planner** (`apps/api/src/services/aiPlanner.service.ts`) — replaced the keyword-matching
  mock with the real multi-provider LLM gateway (`aiGateway.service`). `/create` "Plan graph"
  now produces real plans. The old keyword logic remains **only** as a deterministic offline
  fallback (runs when no LLM key is configured / pool exhausted) so the flow never breaks.
  → Follow-up: once a real provider key is guaranteed in prod, decide whether to drop the
    deterministic fallback entirely.
- **Dead UI placeholders** — removed hardcoded `FORGE` (text-behind-person) and `3D FOLLOW`
  (tracking) demo overlays from `VideoPreview.tsx` (+ their orphaned gates). These were fake
  visualizations that leaked into the live editor preview.

---

## 1. Tool adapter default is `mock` — HIGH priority

**Files:** `packages/shared/src/tool-adapters.ts` (`pickDefaultToolAdapter` → `adapters[0] ?? "mock"`,
`createMockToolRun`), `packages/shared/src/tools.ts` (each tool lists `"mock"` **first** in its
`adapters` array), `apps/web/src/tools/tool-runner.ts` (mock adapter + `runMockBrowserTool`).

**What it fakes:** most editor tool runs default to schema-compatible **fake artifacts** instead of
the real browser computation, because `"mock"` is first in the adapter list.

**Real work:**
- Real browser paths already exist: `local-transcription.ts` (captions), `local-sam.ts` /
  `local-segmentation.ts` (person extraction / bg removal), `local-tracking.ts` +
  `tracking-worker.ts` (motion tracking), `local-inpainting.ts` / `video-inpaint.ts` (inpaint/remove).
- Reorder each tool's `adapters` in `tools.ts` so `"browser"` (or `"cloud"`) is first, and/or change
  `pickDefaultToolAdapter` to prefer a capability-detected browser adapter (via
  `apps/web/src/tools/capabilities.ts`) and only fall back to `mock` when the browser genuinely can't run it.
- Verify **every** tool has a working real adapter before demoting mock. Any tool that only has `mock`
  needs its real adapter built first.
- Then delete `createMockToolRun` + the mock adapter branch (and `runMockBrowserTool`).

**Risk:** high — this is what most tool UI flows run today. Do the capability audit first.

## 2. Server-side asset processing is faked — HIGH priority

**Files:** `apps/api/src/services/mockProcessing.service.ts` (`processSourceAsset`, `mockTrackingData`),
called at `apps/api/src/routes/assets.routes.ts:256`.

**What it fakes:** creates fake `person_mask` / `person_cutout` / `tracking_data` derived assets
(`"mock-soft-mask"`, `"mock-cutout"`, hardcoded `mockTrackingData` frames) server-side.

**Note:** the *other* functions in this file — `renderPreview`, `renderFinal`,
`buildProjectRenderManifest` — are **already real** (they build a real manifest and enqueue a real
`renderJob` the worker consumes). Only `processSourceAsset` + `mockTrackingData` are mock. The file
name is misleading; rename to `assetProcessing.service.ts` when cleaned.

**Real work (pick one):**
- (a) **Client-first:** route asset processing through the existing real browser tools and drop the
  server `processSourceAsset` endpoint, OR
- (b) **Server-side real:** implement real person extraction / tracking in the worker (SAM/segmentation
  + tracker) and have `processSourceAsset` enqueue that instead of fabricating derived assets.
- Decision needed on whether server-side processing is required at all (vs. browser-only).

## 3. `mock-inpaint.ts` — MEDIUM priority (type-extraction refactor)

**Files:** `apps/web/src/tools/mock-inpaint.ts`; type-consumed by the **real** `video-inpaint.ts`,
`local-inpainting.ts`, `inpaint-store.ts`, `layer-effect-handlers.ts`, `RemovePersonToolPanel.tsx`.

**What it fakes:** the fill algorithm (smears nearby background color inward). BUT it also owns the
shared types (`InpaintMask`, `MockInpaintResult`, `MockInpaintFrame`) that the real inpaint code
imports — so it's not a straight delete.

**Real work:**
- Extract the types into a neutral `inpaint-types.ts` and repoint all importers.
- Confirm `local-inpainting.ts` (real ML) is the only fill path, then delete the naive color-smear fill.

## 4. Misc / verify — LOW priority

- **Upload metadata inspection:** `/create` reads real client-side metadata (`readMediaMetadata` in
  `CreatePage.tsx`); confirm the API doesn't still fabricate width/height/duration anywhere.
- **`storage.service.ts`:** confirm `saveDerivedAsset` writes real files (looks real) — verify no
  in-memory stub remains.
- Grep sweep for any remaining `mock` / `placeholder` / `fake` artifact generators once 1–3 land.

---

## Deferred (do NOT touch): Payments

The mock payment provider (`apps/api/src/services/payment.service.ts`, `CheckoutPage`, wallet UI) is
kept as a **shadow payment interface** so users can exercise the real preview flow without making real
payments. Revisit only when a real gateway is chosen. Editor stays free per the monetization doctrine
(charge only real COGS).
