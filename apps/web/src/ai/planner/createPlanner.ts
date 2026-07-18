import { DeterministicPlanner } from "./DeterministicPlanner";
import { LlmPlanner } from "./LlmPlanner";
import type { PlannerProvider } from "../types";

/**
 * Chooses the active planner. The LLM planner (P8) is preferred when the backend
 * advertises a key; it falls back to the deterministic planner per-request on any
 * failure, so the editor is never blocked on the network. Both satisfy the same
 * `PlannerProvider` contract — the executor and UI don't care which ran.
 */
export function createPlanner(): PlannerProvider {
  const fallback = new DeterministicPlanner();
  if (import.meta.env.VITE_ORRERIS_LLM_PLANNER === "off") {
    return fallback;
  }
  return new LlmPlanner(fallback);
}
