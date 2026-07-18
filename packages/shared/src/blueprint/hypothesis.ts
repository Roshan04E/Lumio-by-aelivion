/**
 * Orreris OS — K4 hypothesis-stage planner (ORRERIS_OS.md → Layer 3).
 *
 * A vibe ask ("make it moody", "make this feel dramatic") is not a command — it's a
 * hypothesis problem: does the user mean the PICTURE (a grade, maybe a motion accent) or
 * the TITLES (a text treatment)? This module runs the staged pipeline the doc specifies:
 *
 *   normalize (mood word → recipe) → hypothesize → query the World Model, cheapest first
 *   → expand by information-gain-per-cost → resolve the recipe → emit a multi-goal
 *   Blueprint → `closeBlueprint` (all-or-nothing)
 *
 * Two laws from the doc are load-bearing here:
 *
 *  1. **Budgeted expansion.** A fact is bought only while it can still change the outcome:
 *     `discriminate` facts are bought while hypotheses are near-tied; `shape` facts are
 *     bought only for the WINNING hypothesis (they tune the emitted goals, e.g. footage
 *     already measured dark → gentler grade). Facts that can no longer discriminate
 *     surviving hypotheses are never bought.
 *  2. **The economic clarify rule.** Clarify is not a heuristic: it's what the planner
 *     does when hypothesis entropy stays high (near-tie) and no affordable discriminating
 *     fact remains. Ask the user; don't buy expensive perception to guess.
 *
 * The World Model stays behind an injected `MoodFactSource` so this module is pure and
 * eval-testable; the web route wires it to the Knowledge Service with real budgets.
 * Everything emitted goes through `closeBlueprint` — nothing abstract escapes.
 */

import { resolveLookName } from "../color/looks";
import type { MotionIntent } from "../motion/motion-intent";
import { COLOR_DIALECT_ID } from "./color";
import { MOTION_DIALECT_ID } from "./motion";
import { TEXT_DIALECT_ID } from "./text";
import type { Blueprint, BlueprintGoal, ClosedGoal } from "./types";
import { closeBlueprint } from "./types";

// ---------------------------------------------------------------------------
// Evidence + fact vocabulary
// ---------------------------------------------------------------------------

/** Free structural evidence — read off the composition itself, never bought. */
export interface MoodStructuralEvidence {
  /** Any video/image layer on the timeline (a grade/motion has something to land on). */
  hasVisualMedia: boolean;
  /** Any text layer on the timeline (a text treatment has something to land on). */
  hasText: boolean;
}

/** The World-Model facts this planner knows how to spend budget on. */
export type MoodFactId = "composition-text" | "media-look";

export interface CompositionTextEvidence {
  textLayerCount: number;
  wordCount: number;
  coveredSeconds: number;
  timelineSeconds: number;
}

export interface MediaLookEvidence {
  avgLuma: number;
  contrast: number;
  temperature: number;
  saturation: number;
  exposure: "dark" | "balanced" | "bright";
}

/**
 * The planner's window onto the World Model. Each fetch returns the fact value + the
 * honest access-path label ("cached" / observer id), or null when the Knowledge Service
 * declines (budget, confidence, unobservable) — a decline is an answer, not an error.
 */
export interface MoodFactSource {
  fetchCompositionText(): Promise<{ value: CompositionTextEvidence; path: string } | null>;
  fetchMediaLook(): Promise<{ value: MediaLookEvidence; path: string } | null>;
}

// ---------------------------------------------------------------------------
// Mood recipes — data, not code (adding a mood = one row)
// ---------------------------------------------------------------------------

export interface MoodRecipe {
  /** Canonical mood word ("moody"). */
  mood: string;
  /** Other single words that mean this mood. Kept deliberately tight — precision first. */
  aliases: readonly string[];
  /**
   * Look name for the visual interpretation — resolved through the color dialect's own
   * canonicalization at closure time ("moody" → Noir @ 55%), so recipes may speak alias.
   */
  gradeLook: string;
  /** Optional motion accent composed WITH the grade (this is what makes it multi-goal). */
  motion?: MotionIntent;
  /** Text look used for title treatment (as accent alongside the grade, or standalone). */
  textLook: string;
}

const moodRecipes = new Map<string, MoodRecipe>();

/**
 * Register a mood recipe (SDK v1 surface — ORRERIS_SDK.md). Validated on entry: a recipe
 * with an empty mood word or missing look names would silently break the hypothesis
 * planner's resolution, so it's rejected loudly instead. Duplicate mood words overwrite
 * (last write wins — HMR + deliberate overrides).
 */
export function registerMoodRecipe(recipe: MoodRecipe): boolean {
  const mood = recipe?.mood?.trim().toLowerCase();
  if (!mood || !/^[a-z][a-z-]*$/.test(mood)) {
    console.warn(`[orreris-sdk] mood recipe rejected: mood must be a single lowercase word (got ${JSON.stringify(recipe?.mood)})`);
    return false;
  }
  if (!recipe.gradeLook?.trim() || !recipe.textLook?.trim()) {
    console.warn(`[orreris-sdk] mood recipe "${mood}" rejected: gradeLook and textLook are required`);
    return false;
  }
  if (!Array.isArray(recipe.aliases)) {
    console.warn(`[orreris-sdk] mood recipe "${mood}" rejected: aliases must be an array (may be empty)`);
    return false;
  }
  moodRecipes.set(mood, { ...recipe, mood });
  return true;
}

/** Canonical word or alias, case-insensitive. Null = not a mood this planner owns. */
export function resolveMoodRecipe(word: string): MoodRecipe | null {
  const key = word.trim().toLowerCase();
  for (const recipe of moodRecipes.values()) {
    if (recipe.mood === key || recipe.aliases.includes(key)) {
      return recipe;
    }
  }
  return null;
}

export function listMoodRecipes(): MoodRecipe[] {
  return Array.from(moodRecipes.values());
}

registerMoodRecipe({
  mood: "moody",
  aliases: ["brooding", "gloomy", "somber"],
  gradeLook: "moody", // color alias table → Noir @ 55%
  textLook: "Minimal"
});
registerMoodRecipe({
  mood: "dramatic",
  aliases: ["intense", "punchy"],
  gradeLook: "dramatic", // color alias table → Bleach Bypass @ 60%
  motion: { kind: "emphasis", style: "pulse", intensity: 0.5 },
  textLook: "Headline"
});
registerMoodRecipe({
  mood: "cinematic",
  aliases: ["filmic", "hollywood"],
  gradeLook: "Cinematic",
  motion: { kind: "entrance", style: "scale", durationSeconds: 1.2, intensity: 0.35 },
  textLook: "Lower Third"
});
// K5: adding a mood is registering data, not modifying the runtime (ORRERIS_OS.md rule of
// engagement) — these two rows are the proof.
registerMoodRecipe({
  mood: "vintage",
  aliases: ["retro", "nostalgic"],
  gradeLook: "vintage", // color alias table → Faded Film
  textLook: "Caption Pill"
});
registerMoodRecipe({
  mood: "gritty",
  aliases: ["raw", "edgy"],
  gradeLook: "gritty", // color alias table → Bleach Bypass @ 75%
  motion: { kind: "emphasis", style: "shake", intensity: 0.3 },
  textLook: "Outline"
});

// ---------------------------------------------------------------------------
// The staged pipeline
// ---------------------------------------------------------------------------

const HYPOTHESIS_VISUAL = "visual-grade";
const HYPOTHESIS_TEXT = "text-treatment";

/** Score gap at/above which the leader is dominant and expansion stops. */
const DOMINANCE_MARGIN = 0.12;
/** A `discriminate` fact costing more than this is "expensive" — the clarify trigger. */
const EXPENSIVE_FACT_MS = 800;

interface FactPlanRow {
  id: MoodFactId;
  estCostMs: number;
  role: "discriminate" | "shape";
}

/** Facts this planner may spend budget on, cheapest first (data — observers are plugins). */
const FACT_PLAN: readonly FactPlanRow[] = [
  { id: "composition-text", estCostMs: 30, role: "discriminate" },
  { id: "media-look", estCostMs: 1_500, role: "shape" }
];

export interface MoodHypothesisTraceRow {
  id: string;
  summary: string;
  score: number;
  alive: boolean;
  note?: string | undefined;
}

/** The explainability trace — serializable, per ORRERIS_OS.md's replayability surface. */
export interface MoodTrace {
  mood: string;
  hypotheses: MoodHypothesisTraceRow[];
  factsConsulted: { id: MoodFactId; path: string }[];
  notes: string[];
  /** Stage ids executed, in order — the pipeline's own provenance (additive, K4 refactor). */
  stagesRun?: string[];
}

export type MoodPlanOutcome =
  | { kind: "blueprint"; blueprint: Blueprint; closed: ClosedGoal[]; trace: MoodTrace }
  | { kind: "clarify"; question: string; trace: MoodTrace }
  | { kind: "decline"; reason: string };

// ---------------------------------------------------------------------------
// Registered stages (K4 refactor — ORRERIS_OS.md "planner refactored into registered
// stages"). The planner is an ordered table of stage rows over one mutable state, not a
// monolith: each stage either short-circuits with a final outcome or passes the state on.
// The behavioral contract is UNCHANGED — this is the same pipeline, made legible: the
// trace records which stages ran, and a future planner (or a test) can exercise stages
// in isolation. The stage table is internal (not SDK v1 surface); `listMoodPlannerStages`
// is exported read-only for eval + explainability.
// ---------------------------------------------------------------------------

interface MoodHypothesis {
  id: string;
  summary: string;
  score: number;
  alive: boolean;
}

/** The one mutable state threaded through the stage table. */
interface MoodStageState {
  intent: string;
  recipe: MoodRecipe;
  structural: MoodStructuralEvidence;
  source: MoodFactSource;
  forced?: "visual" | "text" | undefined;
  trace: MoodTrace;
  /** Created by the hypothesize stage; later stages may assert non-null. */
  hypotheses: { visual: MoodHypothesis; text: MoodHypothesis } | null;
  /** Set by clarify-answer (forced) or the clarify stage (dominant leader). */
  winner: MoodHypothesis | null;
  /** Set by the shape stage when evidence says soften the grade. */
  gradeIntensity: number | undefined;
  /** Built by the resolve stage, consumed by close. */
  goals: BlueprintGoal[];
}

interface MoodPlannerStage {
  id: string;
  /** Return a final outcome to short-circuit the pipeline, or null to continue. */
  run(state: MoodStageState): Promise<MoodPlanOutcome | null> | MoodPlanOutcome | null;
}

// Stage: hypothesize (structural gates are free elimination).
// Priors are a deliberate near-tie: when BOTH readings are structurally possible, the
// planner must buy evidence (or ask) rather than assume — that's what makes the
// expansion stage real instead of decorative.
const hypothesizeStage: MoodPlannerStage = {
  id: "hypothesize",
  run(state) {
    const { recipe, structural } = state;
    const visual: MoodHypothesis = {
      id: HYPOTHESIS_VISUAL,
      summary: `grade the picture ${recipe.mood} (a ${recipe.gradeLook}-leaning look${recipe.motion ? " + a motion accent" : ""})`,
      score: 0.55,
      alive: structural.hasVisualMedia
    };
    const text: MoodHypothesis = {
      id: HYPOTHESIS_TEXT,
      summary: `restyle the titles (the "${recipe.textLook}" text look)`,
      score: 0.45,
      alive: structural.hasText
    };
    state.hypotheses = { visual, text };
    if (!visual.alive && !text.alive) {
      return { kind: "decline", reason: "Nothing on the timeline a mood could land on (no visual media, no text)." };
    }
    return null;
  }
};

// Stage: clarify-answer — the user IS the discriminating fact ("the picture"/"the titles"
// after a clarify). Sets the winner outright; expansion and re-clarify become no-ops.
const clarifyAnswerStage: MoodPlannerStage = {
  id: "clarify-answer",
  run(state) {
    if (!state.forced) {
      return null;
    }
    const { visual, text } = state.hypotheses!;
    const chosen = state.forced === "visual" ? visual : text;
    if (!chosen.alive) {
      return {
        kind: "decline",
        reason:
          state.forced === "visual"
            ? "You chose the picture, but there's no video or image on the timeline to grade."
            : "You chose the titles, but there's no text on the timeline to restyle."
      };
    }
    chosen.score = 1; // user-resolved — certainty, honestly labeled in the trace
    state.trace.notes.push(`you answered the clarify — ${chosen.summary}`);
    state.winner = chosen;
    return null;
  }
};

// Stage: budgeted expansion over `discriminate` facts. A fact is bought only while it can
// still change the outcome.
const expandStage: MoodPlannerStage = {
  id: "expand",
  async run(state) {
    if (state.winner) {
      return null; // already resolved by the user's answer — evidence can't change it
    }
    const { visual, text } = state.hypotheses!;
    const surviving = () => [visual, text].filter((h) => h.alive);
    const gap = () => {
      const alive = surviving().sort((a, b) => b.score - a.score);
      return alive.length < 2 ? Number.POSITIVE_INFINITY : alive[0]!.score - alive[1]!.score;
    };

    for (const row of FACT_PLAN) {
      if (row.role !== "discriminate") {
        continue;
      }
      if (gap() >= DOMINANCE_MARGIN) {
        break; // dominant — stop buying; every further fact is waste
      }
      if (row.estCostMs > EXPENSIVE_FACT_MS) {
        break; // near-tie + expensive next fact → the economic clarify rule (next stage)
      }
      const bought = row.id === "composition-text" ? await state.source.fetchCompositionText() : null;
      if (!bought) {
        continue; // Knowledge Service declined — proceed on what we have, never guess harder
      }
      state.trace.factsConsulted.push({ id: row.id, path: bought.path });
      const compositionText = bought.value;
      // Evidence bands: incidental captions concede to the grade; a text-dominant timeline
      // wins outright for the title treatment; the middle band stays a genuine tie.
      const coverage = compositionText.timelineSeconds > 0 ? compositionText.coveredSeconds / compositionText.timelineSeconds : 0;
      if (text.alive && visual.alive) {
        if (coverage > 0.75 && compositionText.wordCount >= 8) {
          text.score += 0.25;
          state.trace.notes.push(`text covers ${Math.round(coverage * 100)}% of the timeline (${compositionText.wordCount} words) — this is a title-driven edit`);
        } else if (coverage > 0.5 && compositionText.wordCount >= 8) {
          text.score += 0.18;
          state.trace.notes.push(`text covers ${Math.round(coverage * 100)}% of the timeline (${compositionText.wordCount} words) — title treatment is a live rival reading`);
        } else {
          text.score -= 0.15;
          state.trace.notes.push(`titles are incidental (${Math.round(coverage * 100)}% coverage) — the picture carries the mood`);
        }
      }
    }
    return null;
  }
};

// Stage: the economic clarify rule — a persisting near-tie with no affordable
// discriminating fact left asks the user; otherwise the leader becomes the winner.
const clarifyStage: MoodPlannerStage = {
  id: "clarify",
  run(state) {
    if (state.winner) {
      return null;
    }
    const { visual, text } = state.hypotheses!;
    const ranked = [visual, text].filter((h) => h.alive).sort((a, b) => b.score - a.score);
    const leader = ranked[0]!;
    const runnerUp = ranked[1];
    if (runnerUp && leader.score - runnerUp.score < DOMINANCE_MARGIN) {
      state.trace.hypotheses = [visual, text].map((h) => ({ ...h }));
      const { recipe } = state;
      // A plain answer resumes THIS pipeline with the chosen reading (the conversational
      // resume); the tier-0 APPLY-LOOK phrasings stay as the explicit escape hatch — every
      // listed answer resolves instantly and locally, one utterance, no model round.
      return {
        kind: "clarify",
        question:
          `${recipe.mood[0]!.toUpperCase()}${recipe.mood.slice(1)} how — the picture or the titles? ` +
          `Just answer **"the picture"** or **"the titles"**. ` +
          `(Or be exact: "apply the ${recipe.gradeLook} look" with a video clip selected, ` +
          `"apply the ${recipe.textLook} look" with a title selected.)`,
        trace: state.trace
      };
    }
    state.winner = leader;
    return null;
  }
};

// Stage: `shape` facts — bought only for the winning hypothesis.
const shapeStage: MoodPlannerStage = {
  id: "shape",
  async run(state) {
    if (state.winner!.id !== HYPOTHESIS_VISUAL) {
      return null;
    }
    const bought = await state.source.fetchMediaLook();
    if (bought) {
      state.trace.factsConsulted.push({ id: "media-look", path: bought.path });
      if (bought.value.exposure === "dark") {
        const base = resolveLookName(state.recipe.gradeLook);
        state.gradeIntensity = Math.max(30, (base?.intensity ?? 70) - 15);
        state.trace.notes.push(
          `footage already measured dark (mean luma ${Math.round(bought.value.avgLuma * 100)}%) — gentler grade @ ${state.gradeIntensity}%`
        );
      }
    }
    return null;
  }
};

// Stage: resolve the recipe into goals for the winner.
const resolveStage: MoodPlannerStage = {
  id: "resolve",
  run(state) {
    const { recipe, structural, gradeIntensity } = state;
    if (state.winner!.id === HYPOTHESIS_VISUAL) {
      state.goals.push({
        id: "goal_color",
        dialect: COLOR_DIALECT_ID,
        summary: `Grade the picture ${recipe.mood}`,
        payload: { look: recipe.gradeLook, ...(gradeIntensity !== undefined ? { lookIntensity: gradeIntensity } : {}) }
      });
      if (recipe.motion) {
        state.goals.push({
          id: "goal_motion",
          dialect: MOTION_DIALECT_ID,
          summary: `${recipe.mood} motion accent`,
          payload: recipe.motion
        });
      }
      // Titles ride along as an accent when they exist — the winner is "make the WHOLE thing
      // feel <mood>", and closure keeps the ensemble atomic.
      if (structural.hasText) {
        state.goals.push({
          id: "goal_text",
          dialect: TEXT_DIALECT_ID,
          summary: `Match the titles to the ${recipe.mood} treatment`,
          payload: { look: recipe.textLook }
        });
      }
    } else {
      state.goals.push({
        id: "goal_text",
        dialect: TEXT_DIALECT_ID,
        summary: `Restyle the titles ${recipe.mood}`,
        payload: { look: recipe.textLook }
      });
    }
    return null;
  }
};

// Stage: emit + close (all-or-nothing; nothing abstract escapes). Always terminal.
const closeStage: MoodPlannerStage = {
  id: "close",
  run(state) {
    const blueprint: Blueprint = { id: `bp_mood_${state.recipe.mood}`, intent: state.intent, goals: state.goals };
    const result = closeBlueprint(blueprint);
    if (!result.ok) {
      // A recipe referencing a capability the registries don't carry is a data bug — decline
      // honestly with the closure's own reasons rather than executing a partial plan.
      return {
        kind: "decline",
        reason: result.issues.map((issue) => issue.message).join(" ")
      };
    }
    const { visual, text } = state.hypotheses!;
    state.trace.hypotheses = [visual, text].map((h) => ({ ...h }));
    for (const closed of result.closed) {
      state.trace.notes.push(...closed.repairs);
    }
    return { kind: "blueprint", blueprint, closed: result.closed, trace: state.trace };
  }
};

/** The ordered stage table — the planner IS this data. */
const MOOD_PLANNER_STAGES: readonly MoodPlannerStage[] = [
  hypothesizeStage,
  clarifyAnswerStage,
  expandStage,
  clarifyStage,
  shapeStage,
  resolveStage,
  closeStage
];

/** Read-only view of the stage table for eval + explainability surfaces. */
export function listMoodPlannerStages(): string[] {
  return MOOD_PLANNER_STAGES.map((stage) => stage.id);
}

export async function planMoodBlueprint(
  intent: string,
  recipe: MoodRecipe,
  structural: MoodStructuralEvidence,
  source: MoodFactSource,
  /**
   * A clarify ANSWER ("the picture" / "the titles") — the user resolved the hypothesis
   * themselves, so expansion and the clarify rule become no-ops and the chosen reading
   * wins outright (structural gates still apply: choosing a reading with nothing to land
   * on is an honest decline, never a silent no-op).
   */
  forced?: "visual" | "text"
): Promise<MoodPlanOutcome> {
  const trace: MoodTrace = { mood: recipe.mood, hypotheses: [], factsConsulted: [], notes: [], stagesRun: [] };
  const state: MoodStageState = {
    intent,
    recipe,
    structural,
    source,
    forced,
    trace,
    hypotheses: null,
    winner: null,
    gradeIntensity: undefined,
    goals: []
  };
  for (const stage of MOOD_PLANNER_STAGES) {
    trace.stagesRun!.push(stage.id);
    const outcome = await stage.run(state);
    if (outcome) {
      return outcome;
    }
  }
  // closeStage is terminal by contract — reaching here is a stage-table wiring bug.
  return { kind: "decline", reason: "Mood planner ended without an outcome (stage-table wiring bug)." };
}
