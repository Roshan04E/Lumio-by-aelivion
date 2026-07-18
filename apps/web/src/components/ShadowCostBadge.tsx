import { Sparkles } from "lucide-react";
import { creditCost, type BillableUnit } from "@orreris/shared";

/**
 * Phase 0 shadow-billing badge (MONETIZATION_STRATEGY.md §4): shows what a cloud action WOULD
 * cost, always labeled "free during beta". Read-only — never gates the action it sits next to,
 * never touches walletCredits. Mount next to a generation/caption/AI trigger button.
 */
export function ShadowCostBadge({ action, units }: { action: string; units: number }) {
  const credits = creditCost(action, units);
  if (credits <= 0) {
    return null;
  }
  return (
    <span className="shadow-cost-badge" title="Usage is measured during beta but never charged or gated.">
      <Sparkles size={12} />
      {`~${credits} credit${credits === 1 ? "" : "s"} · free during beta`}
    </span>
  );
}

/** Convenience: derive units from a raw quantity + unit kind (e.g. seconds -> video_second passthrough,
 *  seconds -> transcription_minute /60) so callers don't duplicate the unit-conversion math. */
export function unitsFor(unit: BillableUnit, quantity: number): number {
  if (unit === "transcription_minute" || unit === "cloud_render_minute") {
    return quantity / 60;
  }
  return quantity;
}
