/**
 * Phase 0 — shadow-billing vocabulary. See MONETIZATION_STRATEGY.md §4: the editor is free
 * forever, we charge only for things that cost *us* real money (cloud AI keys, fal.ai
 * generation, cloud transcription/render). This module is pure data + one pricing function —
 * no runtime behavior, no gating, nothing decrements a wallet. Every cloud action gets priced
 * in **value units** (never token math) so we can show a "this used N credits — free during
 * beta" badge and learn real per-feature demand before Phase 1 (real payments).
 *
 * Numbers are reconciled from what already exists in the repo, not invented:
 *  - `catalog.ts` → `moduleCatalog[].estimatedCostCredits` (module-level flat estimates)
 *  - `skills/model-registry.ts` → `modelCapabilityRegistry[].cost` (per-generation-model credits)
 * See the `// TODO(phase1)` markers on those files — this phase deliberately does NOT collapse
 * them into `creditCost()`.
 */

export type BillableUnit = "image" | "video_second" | "transcription_minute" | "llm_call" | "cloud_render_minute";

export interface BillableSurface {
  /** Stable id, e.g. "generate.text-to-video". */
  action: string;
  unit: BillableUnit;
  /** Value-unit price — never token math. */
  creditsPerUnit: number;
  /** Kling-pattern daily free count (informational only in Phase 0; 0 = none, NEVER enforced/blocked). */
  freeDailyAllowance: number;
  /** Our COGS estimate in USD per unit, for the future margin audit (§4 "transparent markup"). */
  providerCostUsdPerUnit: number;
  /** Shown on the shadow-bill badge. */
  label: string;
}

// ---- fal.ai image generation ---------------------------------------------------------------
// model-registry.ts costs: fal-flux-schnell=2, fal-flux-dev=4, fal-flux-img2img=4,
// fal-flux-inpaint=5 (also covers outpaint), fal-esrgan=2.
const IMAGE_SURFACES: BillableSurface[] = [
  {
    action: "generate.text-to-image",
    unit: "image",
    creditsPerUnit: 3, // midpoint of schnell(2)/dev(4), the two cloud models serving this task kind
    freeDailyAllowance: 3,
    providerCostUsdPerUnit: 0.01, // fal FLUX per-image estimate
    label: "AI image generation"
  },
  {
    action: "generate.image-to-image",
    unit: "image",
    creditsPerUnit: 4,
    freeDailyAllowance: 3,
    providerCostUsdPerUnit: 0.01,
    label: "AI image edit"
  },
  {
    action: "generate.inpaint",
    unit: "image",
    creditsPerUnit: 5,
    freeDailyAllowance: 3,
    providerCostUsdPerUnit: 0.012,
    label: "AI inpaint"
  },
  {
    action: "generate.outpaint",
    unit: "image",
    creditsPerUnit: 5,
    freeDailyAllowance: 3,
    providerCostUsdPerUnit: 0.012,
    label: "AI outpaint"
  },
  {
    action: "generate.upscale",
    unit: "image",
    creditsPerUnit: 2,
    freeDailyAllowance: 5,
    providerCostUsdPerUnit: 0.005,
    label: "AI upscale"
  }
];

// ---- fal.ai video generation ---------------------------------------------------------------
// model-registry.ts costs are per-job, not per-second: fal-ltx-t2v=20cr/≤5s ≈4cr/s,
// fal-kling-i2v=40cr/≤10s ≈4cr/s, fal-kling-t2v=40cr/≤10s ≈4cr/s — all reconcile to 4/s.
const VIDEO_SURFACES: BillableSurface[] = [
  {
    action: "generate.text-to-video",
    unit: "video_second",
    creditsPerUnit: 4,
    freeDailyAllowance: 0,
    providerCostUsdPerUnit: 0.07, // fal Kling/LTX per-second estimate
    label: "AI video generation"
  },
  {
    action: "generate.image-to-video",
    unit: "video_second",
    creditsPerUnit: 4,
    freeDailyAllowance: 0,
    providerCostUsdPerUnit: 0.07,
    label: "AI image-to-video"
  }
];

// ---- Cloud transcription (Gemini) ------------------------------------------------------------
// catalog.ts mod_auto_captions.estimatedCostCredits=4 (flat per-job estimate for a typical clip);
// reconciled here as a per-minute rate.
const TRANSCRIPTION_SURFACES: BillableSurface[] = [
  {
    action: "caption.cloud-transcribe",
    unit: "transcription_minute",
    creditsPerUnit: 4,
    freeDailyAllowance: 5,
    providerCostUsdPerUnit: 0.01, // Gemini audio-in per-minute estimate
    label: "Cloud transcription"
  }
];

// ---- Cloud LLM assistant (planner/consultant) ------------------------------------------------
// Phase 0 bills per-call (`unit: "llm_call"`, `units: 1`) — planWithGateway/streamPlanWithGateway
// return providerId but not token counts, so per-call demand is what we measure this phase.
// TODO(phase1): parse provider `usage` for accurate providerCost once the gateway surfaces it.
const LLM_SURFACES: BillableSurface[] = [
  {
    action: "assistant.plan",
    unit: "llm_call",
    creditsPerUnit: 1,
    freeDailyAllowance: 20,
    providerCostUsdPerUnit: 0.01,
    label: "AI planner call"
  },
  {
    action: "assistant.plan.fast",
    unit: "llm_call",
    creditsPerUnit: 1,
    freeDailyAllowance: 20,
    providerCostUsdPerUnit: 0.004,
    label: "AI fast-plan call"
  },
  {
    action: "assistant.ack",
    unit: "llm_call",
    creditsPerUnit: 1,
    freeDailyAllowance: 40,
    providerCostUsdPerUnit: 0.001,
    label: "AI ack call"
  },
  {
    action: "assistant.plan.stream",
    unit: "llm_call",
    creditsPerUnit: 1,
    freeDailyAllowance: 20,
    providerCostUsdPerUnit: 0.01,
    label: "AI planner call (streamed)"
  },
  {
    action: "assistant.chat.stream",
    unit: "llm_call",
    creditsPerUnit: 1,
    freeDailyAllowance: 20,
    providerCostUsdPerUnit: 0.01,
    label: "AI chat call"
  }
];

// ---- Cloud render (future — not wired to a hook point in Phase 0) ---------------------------
// catalog.ts mod_final_render.estimatedCostCredits=1 (flat), reconciled as a per-minute rate.
const RENDER_SURFACES: BillableSurface[] = [
  {
    action: "render.cloud-export",
    unit: "cloud_render_minute",
    creditsPerUnit: 1,
    freeDailyAllowance: 0,
    providerCostUsdPerUnit: 0.05,
    label: "Cloud render"
  }
];

export const billableSurfaces: Record<string, BillableSurface> = Object.fromEntries(
  [...IMAGE_SURFACES, ...VIDEO_SURFACES, ...TRANSCRIPTION_SURFACES, ...LLM_SURFACES, ...RENDER_SURFACES].map(
    (surface) => [surface.action, surface]
  )
);

/**
 * Credit cost for `units` of `action`. Never negative, always a whole credit (`Math.ceil`), and
 * an unknown action prices at 0 — this is telemetry, so an unrecognized surface should never
 * throw or block. Doctrine: this is metadata only. Nothing calling this may decrement
 * `user.walletCredits` or gate a capability.
 */
export function creditCost(action: string, units: number): number {
  const surface = billableSurfaces[action];
  if (!surface || !Number.isFinite(units)) {
    return 0;
  }
  return Math.max(0, Math.ceil(units * surface.creditsPerUnit));
}
