/**
 * Kimera OS — Blueprint motion dialect (K3, second dialect). Payload = MotionIntent
 * (motion-intent.ts). Closure canonicalizes the style against the motion vocabulary
 * (exact → alias, repairs recorded) and fails unknown styles with the per-kind vocabulary
 * as suggestions. Lowering = one `applyMotion` action template — the deterministic compiler
 * runs inside the action against the bound layer's real transform/duration, so the lowering
 * needs no target knowledge here (targets are executor business, per the IR law).
 */

import { motionIntentSchema, MOTION_STYLES, resolveMotionStyle, type MotionIntent } from "../motion/motion-intent";
import type { BlueprintDialect, BlueprintGoal, CloseResult } from "./types";
import { registerBlueprintDialect } from "./types";

export const MOTION_DIALECT_ID = "motion";

function close(goal: BlueprintGoal<MotionIntent>): CloseResult<MotionIntent> {
  const resolved = resolveMotionStyle(goal.payload.kind, goal.payload.style);
  if (!resolved) {
    return {
      ok: false,
      issues: [
        {
          goalId: goal.id,
          code: "unknown-capability",
          message: `"${goal.payload.style}" isn't a ${goal.payload.kind} style.`,
          suggestions: [...MOTION_STYLES[goal.payload.kind]]
        }
      ]
    };
  }
  const payload: MotionIntent = { ...goal.payload, style: resolved.style };
  return {
    ok: true,
    closed: {
      goal: { ...goal, payload },
      actions: [
        {
          actionId: "applyMotion",
          params: { ...payload },
          summary: `${resolved.style} ${payload.kind} motion`
        }
      ],
      repairs: resolved.repair ? [resolved.repair] : []
    }
  };
}

export const motionBlueprintDialect: BlueprintDialect<MotionIntent> = {
  id: MOTION_DIALECT_ID,
  schema: motionIntentSchema,
  close
};

registerBlueprintDialect(motionBlueprintDialect);
