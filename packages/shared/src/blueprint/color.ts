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
import { listCreativeLooks } from "../color/looks";
import type { BlueprintDialect, BlueprintGoal, ClosureIssue, CloseResult, LoweredAction } from "./types";
import { registerBlueprintDialect } from "./types";

export const COLOR_DIALECT_ID = "color";

/**
 * Colorist alias table — the recipe layer's vocabulary for look names the LLM plausibly
 * emits but the registry doesn't carry verbatim. Data, not code: adding a mood = one row.
 * Intensity (0–100) lets an alias land a SOFTER version of a strong base look.
 */
const LOOK_ALIASES: Record<string, { look: string; intensity?: number }> = {
  moody: { look: "Noir", intensity: 55 },
  dark: { look: "Noir", intensity: 50 },
  dramatic: { look: "Bleach Bypass", intensity: 60 },
  gritty: { look: "Bleach Bypass", intensity: 75 },
  vintage: { look: "Faded Film" },
  retro: { look: "Faded Film" },
  analog: { look: "Faded Film" },
  faded: { look: "Faded Film" },
  film: { look: "Cinematic" },
  filmic: { look: "Cinematic" },
  movie: { look: "Cinematic" },
  hollywood: { look: "Teal & Orange" },
  blockbuster: { look: "Teal & Orange" },
  warm: { look: "Warm Sunset" },
  golden: { look: "Warm Sunset" },
  sunset: { look: "Warm Sunset" },
  cold: { look: "Cold Morning" },
  cool: { look: "Cold Morning" },
  winter: { look: "Cold Morning" },
  monochrome: { look: "Noir" },
  "black and white": { look: "Noir" },
  noirish: { look: "Noir" }
};

/** Lowercase + collapse separators + spell out "&" so "Teal and Orange" ≡ "teal&orange". */
function normalizeLookKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface LookResolution {
  /** Canonical registry name. */
  look: string;
  /** Intensity override carried by an alias (softer variant of a strong base). */
  intensity?: number | undefined;
  /** Human repair note when the input was rewritten; undefined for an exact match. */
  repair?: string | undefined;
}

/** Resolve a requested look against the LIVE registry: exact → case/format-insensitive → alias. */
export function resolveLookName(requested: string): LookResolution | null {
  const available = listCreativeLooks();
  const exact = available.find((look) => look.name === requested);
  if (exact) {
    return { look: exact.name };
  }
  const key = normalizeLookKey(requested);
  const relaxed = available.find((look) => normalizeLookKey(look.name) === key);
  if (relaxed) {
    return { look: relaxed.name, repair: `look "${requested}" → ${relaxed.name}` };
  }
  const alias = LOOK_ALIASES[key];
  if (alias && available.some((look) => look.name === alias.look)) {
    return {
      look: alias.look,
      intensity: alias.intensity,
      repair: `look "${requested}" → ${alias.look}${alias.intensity !== undefined ? ` @ ${alias.intensity}%` : ""}`
    };
  }
  return null;
}

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
