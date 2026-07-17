/**
 * Kimera OS observer — User State (K2, L0, free). Summarizes the brain's own learning data
 * (B6 per-rule trust counters + the routing ledger) as a queryable fact: how often the local
 * tiers resolve this user's asks, which rules they distrust, estimated tokens saved. This is
 * the "the brain can introspect its own learning" branch of the World Model — all data that
 * already lives on-device; nothing new is collected. Target: `user:local`.
 */

import { isRuleTrusted, listRuleStats } from "../../brain/feedback";
import { summarizeRouting } from "../../brain/ledger";
import type { WorldContext, WorldObserver, WorldTarget } from "../types";
import { fnv1a } from "../types";

export const USER_AI_PROFILE_FACT = "user.aiProfile";
export const USER_TARGET_ID = "local";

export interface UserAiProfileFact {
  rulesTracked: number;
  totalFired: number;
  totalConfirmed: number;
  totalRejected: number;
  /** Rules this user has 👎-ed below their trust gate (they escalate to the model now). */
  distrustedRuleIds: string[];
  /** 0–1 share of recent requests resolved by zero-token local tiers. */
  instantShare: number;
  estTokensSaved: number;
}

function build(): UserAiProfileFact {
  const stats = listRuleStats();
  const routing = summarizeRouting();
  let fired = 0;
  let confirmed = 0;
  let rejected = 0;
  const distrusted: string[] = [];
  for (const [ruleId, entry] of Object.entries(stats)) {
    fired += entry.fired;
    confirmed += entry.confirmed;
    rejected += entry.rejected;
    if (!isRuleTrusted(ruleId)) {
      distrusted.push(ruleId);
    }
  }
  return {
    rulesTracked: Object.keys(stats).length,
    totalFired: fired,
    totalConfirmed: confirmed,
    totalRejected: rejected,
    distrustedRuleIds: distrusted.sort(),
    instantShare: routing.instantShare,
    estTokensSaved: routing.estTokensSaved
  };
}

function applies(target: WorldTarget): boolean {
  return target.kind === "user" && target.id === USER_TARGET_ID;
}

export const userProfileObserver: WorldObserver = {
  id: "user-profile@builtin",
  version: 1,
  factTypes: [USER_AI_PROFILE_FACT],
  fidelity: 0,
  estCostMs: 2,
  estConfidence: 0.95,
  signature(target, _ctx: WorldContext) {
    if (!applies(target)) {
      return null;
    }
    // The summary IS the signature: any new 👍/👎/route entry changes it → auto-invalidation.
    return fnv1a(JSON.stringify(build()));
  },
  async observe(target) {
    if (!applies(target)) {
      return [];
    }
    return [{ type: USER_AI_PROFILE_FACT, value: build(), confidence: 0.95 }];
  }
};
