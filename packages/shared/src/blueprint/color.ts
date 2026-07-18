/**
 * Kimera OS — Blueprint color dialect (K3). Payload = the shipped `GradeIntent` (this
 * dialect FORMALIZES what GradeIntent proved — same schema, same deterministic compiler,
 * now with capability closure in front).
 *
 * What closure adds over raw `compileGradeIntent`:
 *  1. **Look canonicalization** — `look` names resolve against the LIVE creative-look
 *     registry (built-ins + plugin-registered), case-insensitively and through a small
 *     colorist alias table ("moody" → Noir @ 60%). Every rewrite is recorded as a repair.
 *  2. **Unknown looks are compile errors** — with the available-look list as suggestions,
 *     instead of silently resolving to nothing (the "moody no-op": `look:"Moody"` passed
 *     the schema, exact-match registry lookup returned [], user saw "Applied 0 · skipped").
 *  3. **Emptiness is unrepresentable downstream** — closure lowers the intent through
 *     `compileGradeIntent` and fails with `empty-goal` when the stack is empty, so an
 *     all-neutral grade can never reach the executor.
 */

import { compileGradeIntent, gradeIntentSchema, type GradeIntent } from "../color/grade-intent";
import { listCreativeLooks, resolveLookName } from "../color/looks";
import type { BlueprintDialect, BlueprintGoal, ClosureIssue, CloseResult, LoweredAction } from "./types";
import { registerBlueprintDialect } from "./types";

export const COLOR_DIALECT_ID = "color";

// Look-name resolution (exact → case/format-insensitive → colorist alias table) lives in
// color/looks.ts next to the registry — the ONE resolution shared by this dialect, the
// addEffect `look`-param canonicalization, and any future picker.

function close(goal: BlueprintGoal<GradeIntent>): CloseResult<GradeIntent> {
  const repairs: string[] = [];
  let payload: GradeIntent = goal.payload;

  if (payload.look) {
    const resolved = resolveLookName(payload.look);
    if (!resolved) {
      const issue: ClosureIssue = {
        goalId: goal.id,
        code: "unknown-capability",
        message: `"${payload.look}" isn't in the look library.`,
        suggestions: listCreativeLooks().map((look) => look.name)
      };
      return { ok: false, issues: [issue] };
    }
    if (resolved.repair) {
      repairs.push(resolved.repair);
      payload = {
        ...payload,
        look: resolved.look,
        // An alias intensity only fills in when the intent didn't specify its own.
        lookIntensity: payload.lookIntensity ?? resolved.intensity
      };
    }
  }

  const stack = compileGradeIntent(payload);
  if (stack.length === 0) {
    const issue: ClosureIssue = {
      goalId: goal.id,
      code: "empty-goal",
      message:
        "The grade contains no color change — name a look from the library or give at least one adjustment (exposure, contrast, a color push…).",
      suggestions: listCreativeLooks().map((look) => look.name)
    };
    return { ok: false, issues: [issue] };
  }

  const actions: LoweredAction[] = stack.map((grade) => ({
    actionId: "addEffect",
    params: { effectType: grade.effectType, params: grade.params },
    summary: grade.summary
  }));
  return { ok: true, closed: { goal: { ...goal, payload }, actions, repairs } };
}

export const colorBlueprintDialect: BlueprintDialect<GradeIntent> = {
  id: COLOR_DIALECT_ID,
  schema: gradeIntentSchema,
  close
};

registerBlueprintDialect(colorBlueprintDialect);

/**
 * Convenience seam for today's skill executor: close ONE color goal from a raw payload.
 * (The full multi-goal `closeBlueprint` driver is the K4 planner's entry point.)
 */
export function closeColorGrade(payload: unknown): CloseResult<GradeIntent> {
  const parsed = gradeIntentSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [
        {
          goalId: "color_goal",
          code: "invalid-payload",
          message: `Couldn't read the color grade: ${parsed.error.issues[0]?.message ?? "invalid"}.`
        }
      ]
    };
  }
  return close({ id: "color_goal", dialect: COLOR_DIALECT_ID, summary: "Color grade", payload: parsed.data });
}
