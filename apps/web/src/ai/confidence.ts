import type { AiPlan } from "./types";

/**
 * Confidence is communicated as a label, never a percentage (Lumio AI rule).
 * Each label gets a short, honest explanation surfaced in the Plan Review card.
 */
export const CONFIDENCE_INFO: Record<AiPlan["confidence"], { tone: string; detail: string }> = {
  Exact: {
    tone: "exact",
    detail: "Maps directly to known tools and editable actions. Predictable result."
  },
  "High Quality": {
    tone: "high",
    detail: "Strong match, but a step needs your input or has options worth confirming."
  },
  Approximation: {
    tone: "approx",
    detail: "Closest available interpretation — review the steps before applying."
  },
  Experimental: {
    tone: "experimental",
    detail: "I'm unsure I understood. Nothing will change until you confirm."
  }
};

export function confidenceClass(confidence: AiPlan["confidence"]): string {
  return `is-${confidence.replace(/\s+/g, "-").toLowerCase()}`;
}
