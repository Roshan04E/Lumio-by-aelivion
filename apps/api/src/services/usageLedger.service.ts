import { billableSurfaces, creditCost } from "@kimera-by-aelivion/shared";
import { prisma } from "../lib/prisma";

/**
 * Phase 0 shadow-billing ledger — see MONETIZATION_STRATEGY.md §4 and `billing/pricing.ts`.
 * Additive telemetry only: every write is `type: "usage", shadow: true`. This function must
 * NEVER touch `user.walletCredits` and must NEVER throw into the caller — a telemetry failure
 * can never break a real user action (generation/transcription/AI reply), so the whole body is
 * wrapped in try/catch that only logs.
 */
export async function recordUsage(input: {
  userId: string;
  action: string;
  units: number;
  provider?: string | undefined;
}): Promise<void> {
  try {
    const surface = billableSurfaces[input.action];
    const credits = creditCost(input.action, input.units);
    const providerCost = surface ? Number((surface.providerCostUsdPerUnit * input.units).toFixed(6)) : 0;

    await prisma.walletTransaction.create({
      data: {
        userId: input.userId,
        type: "usage",
        shadow: true,
        credits,
        reason: surface ? `${surface.label} — free during beta` : `${input.action} — free during beta`,
        action: input.action,
        unit: surface?.unit ?? null,
        units: input.units,
        provider: input.provider ?? null,
        providerCost
      }
    });
  } catch (error) {
    // Telemetry must never break the calling action.
    // eslint-disable-next-line no-console
    console.error(`[usageLedger] failed to record usage for ${input.action}:`, error);
  }
}
