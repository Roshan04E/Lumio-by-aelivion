/**
 * Orreris OS — K4 hypothesis-route (Layer 3's brain-tier wiring). Vibe asks ("make it
 * moody", "make this feel dramatic") that tiers 0–2 decline run the shared hypothesis
 * pipeline (`@orreris/shared` blueprint/hypothesis.ts): hypothesize → query the World
 * Model with budgets → resolve the mood recipe → close a multi-goal Blueprint — then bind
 * targets and emit an ordinary AiPlan through the SAME pipeline every other plan takes
 * (approval bar in professional mode, undoable commits, honest notes).
 *
 * Precision-first like every tier: the trigger is whole-string anchored, the mood word
 * must resolve against the recipe registry, and anything else escalates silently ("make it
 * faster" is not this tier's business). The economic clarify rule surfaces as an instant
 * answer whose suggested follow-ups are tier-0 phrasings — either answer then resolves
 * locally for free.
 */

import {
  brainPlan,
  normalizePrompt,
  type BrainContext,
  type BrainRouteResult
} from "../brain/router";
import { isRuleTrusted } from "../brain/feedback";
import {
  planMoodBlueprint,
  resolveMoodRecipe,
  resolveTargetLayer,
  type ClosedGoal,
  type MoodFactSource,
  type MoodTrace,
  type TimelineComposition,
  type TimelineLayer,
  COLOR_DIALECT_ID,
  MOTION_DIALECT_ID,
  TEXT_DIALECT_ID
} from "@orreris/shared";
import { queryFact } from "./knowledge";
import type { WorldContext } from "./types";
import type { CompositionTextFact } from "./observers/text-summary";
import { COMPOSITION_TEXT_FACT } from "./observers/text-summary";
import type { MediaLookFact } from "./observers/look";
import { MEDIA_LOOK_FACT } from "./observers/look";

const ESCALATE: BrainRouteResult = { kind: "escalate" };

const MOOD_RULE_ID = "k4.mood-blueprint";
const CLARIFY_RULE_ID = "k4.mood-clarify";

/** How many title layers a mood treatment will restyle in one plan. */
const MAX_TEXT_TARGETS = 6;

// Whole-string anchored, like every local tier. The captured tail must resolve against the
// mood-recipe registry or we escalate — compound creative asks ("dreamy and warm") belong
// to the model tiers.
const MOOD_ASK_RE =
  /^make (?:it|this|everything|the (?:video|edit|timeline|whole thing)) (?:feel |look )?(?:a bit |a little |more |really |super )?([a-z][a-z -]{2,24}?)$/;

// ---------------------------------------------------------------------------
// Conversational clarify resume (K4 tail)
//
// When the economic clarify fires ("Moody how — the picture or the titles?"), the mood +
// original ask are parked here so the user's NEXT utterance can answer in plain words
// ("the picture", "titles", "both") instead of the exact tier-0 phrasing. The window is
// deliberately narrow: single pending slot (a new clarify overwrites), short TTL, and the
// answer grammar is whole-string anchored — anything else routes normally, so a user who
// ignores the question and asks for something different is never hijacked.
// ---------------------------------------------------------------------------

const CLARIFY_RESUME_TTL_MS = 2 * 60_000;

interface PendingMoodClarify {
  /** Canonical mood word the clarify was about — re-resolved against the registry on resume. */
  mood: string;
  /** The ORIGINAL vibe ask — the resumed plan is named after it, not after "the picture". */
  prompt: string;
  expiresAt: number;
}

let pendingMoodClarify: PendingMoodClarify | null = null;

export function setPendingMoodClarify(mood: string, prompt: string, now: number = Date.now()): void {
  pendingMoodClarify = { mood, prompt, expiresAt: now + CLARIFY_RESUME_TTL_MS };
}

export function peekPendingMoodClarify(now: number = Date.now()): { mood: string; prompt: string } | null {
  if (pendingMoodClarify && pendingMoodClarify.expiresAt <= now) {
    pendingMoodClarify = null; // a stale answer out of nowhere must not resurrect an old ask
  }
  return pendingMoodClarify;
}

export function clearPendingMoodClarify(): void {
  pendingMoodClarify = null;
}

// Whole-string anchored answer grammar. "both"/"everything" map to visual because the
// visual winner already carries the title accent when text exists (the multi-goal path).
const CLARIFY_VISUAL_ANSWER_RE =
  /^(?:(?:the|my) )?(?:picture|video|clips?|footage|visuals?|image|colou?rs?)$|^grade the picture$|^both$|^everything$/;
const CLARIFY_TEXT_ANSWER_RE = /^(?:(?:the|my) )?(?:titles?|text|captions?)$|^restyle the (?:text|titles)$/;

/** Pure + exported for eval. Null = not a clarify answer (route the prompt normally). */
export function parseMoodClarifyAnswer(text: string): "visual" | "text" | null {
  if (CLARIFY_VISUAL_ANSWER_RE.test(text)) {
    return "visual";
  }
  if (CLARIFY_TEXT_ANSWER_RE.test(text)) {
    return "text";
  }
  return null;
}

/** Lazy for the same reason route.ts is: world/index pulls Vite-only modules. */
async function worldContext(composition: TimelineComposition): Promise<WorldContext | null> {
  try {
    const { buildWorldContext } = await import("./index");
    return buildWorldContext(composition);
  } catch {
    return null;
  }
}

function allLayers(composition: TimelineComposition): TimelineLayer[] {
  return composition.tracks.flatMap((track) => track.layers);
}

/** Selection → playhead → first visual layer on the timeline. Null = nothing to grade. */
function resolveVisualTarget(context: BrainContext): TimelineLayer | null {
  const layers = allLayers(context.composition);
  const isVisual = (l: TimelineLayer) => l.type === "video" || l.type === "image";
  const bound = resolveTargetLayer(context.composition, { selection: context.selection, nowSeconds: context.nowSeconds });
  if (bound.layerId) {
    const layer = layers.find((l) => l.id === bound.layerId);
    if (layer && isVisual(layer)) {
      return layer;
    }
  }
  return layers.find(isVisual) ?? null;
}

export async function routePromptHypothesis(prompt: string, context: BrainContext): Promise<BrainRouteResult> {
  const text = normalizePrompt(prompt);
  if (!text || text.length > 80) {
    return ESCALATE;
  }

  // Conversational clarify resume: a pending question + a plain answer → re-run the
  // pipeline with the user's reading as the (certain) winner. Consumed only on a match —
  // any other prompt routes normally and the pending slot just ages out.
  const pending = peekPendingMoodClarify();
  if (pending) {
    const choice = parseMoodClarifyAnswer(text);
    if (choice) {
      const ctx = await worldContext(context.composition);
      if (ctx) {
        clearPendingMoodClarify();
        return routeMoodAskWithContext(pending.prompt, context, ctx, pending.mood, choice);
      }
    }
  }

  const match = MOOD_ASK_RE.exec(text);
  if (!match) {
    return ESCALATE;
  }
  const recipe = resolveMoodRecipe(match[1]!);
  if (!recipe) {
    return ESCALATE; // not a mood this planner owns — the model tiers take it
  }

  const ctx = await worldContext(context.composition);
  if (!ctx) {
    return ESCALATE;
  }
  return routeMoodAskWithContext(prompt, context, ctx, recipe.mood);
}

/**
 * The context-injected core — exported for eval (node has no Vite world/index). `moodWord`
 * is pre-resolved by the caller.
 */
export async function routeMoodAskWithContext(
  prompt: string,
  context: BrainContext,
  ctx: WorldContext,
  moodWord: string,
  /** A parsed clarify answer — forces that hypothesis instead of re-asking. */
  forced?: "visual" | "text"
): Promise<BrainRouteResult> {
  const recipe = resolveMoodRecipe(moodWord);
  if (!recipe) {
    return ESCALATE;
  }
  const layers = allLayers(context.composition);
  const visualTarget = resolveVisualTarget(context);
  const textTargets = layers.filter((l) => l.type === "text").slice(0, MAX_TEXT_TARGETS);
  const structural = { hasVisualMedia: visualTarget !== null, hasText: textTargets.length > 0 };

  // The World-Model window, with real budgets: the cheap discriminator gets a snappy
  // budget; the expensive shaping fact gets the look observer's real cost (and is bought
  // by the pipeline only for a winning visual hypothesis).
  const source: MoodFactSource = {
    fetchCompositionText: async () => {
      const result = await queryFact<CompositionTextFact>(
        { type: COMPOSITION_TEXT_FACT, target: { kind: "composition", id: context.composition.id }, budgetMs: 400 },
        ctx
      );
      return result ? { value: result.fact.value, path: result.path } : null;
    },
    fetchMediaLook: async () => {
      if (!visualTarget?.assetId) {
        return null;
      }
      const result = await queryFact<MediaLookFact>(
        { type: MEDIA_LOOK_FACT, target: { kind: "asset", id: visualTarget.assetId }, budgetMs: 2_000 },
        ctx
      );
      return result ? { value: result.fact.value, path: result.path } : null;
    }
  };

  const outcome = await planMoodBlueprint(prompt, recipe, structural, source, forced);
  if (outcome.kind === "decline") {
    // A forced choice that can't land ("the titles" with no text) deserves the honest
    // reason, not a silent model escalation of the bare answer word.
    return forced ? { kind: "answer", text: outcome.reason, tier: "world", ruleId: CLARIFY_RULE_ID } : ESCALATE;
  }
  if (outcome.kind === "clarify") {
    if (!isRuleTrusted(CLARIFY_RULE_ID)) {
      return ESCALATE;
    }
    // Park the ask so the user's next utterance can answer in plain words ("the picture").
    setPendingMoodClarify(recipe.mood, prompt);
    return { kind: "answer", text: outcome.question, tier: "world", ruleId: CLARIFY_RULE_ID };
  }

  const plan = bindClosedGoals(prompt, outcome.closed, visualTarget, textTargets);
  if (!plan) {
    return ESCALATE;
  }
  plan.notes = traceNotes(outcome.trace);
  clearPendingMoodClarify(); // a resolved mood plan supersedes any open question
  return isRuleTrusted(MOOD_RULE_ID) ? { kind: "plan", plan, tier: "world", ruleId: MOOD_RULE_ID } : ESCALATE;
}

/**
 * Targets are executor business (the IR law): bind the closed goals' action templates to
 * real layers — color/motion onto the visual target, the text look onto every title (cap).
 */
function bindClosedGoals(
  prompt: string,
  closed: ClosedGoal[],
  visualTarget: TimelineLayer | null,
  textTargets: TimelineLayer[]
) {
  const steps: { actionId: string; params: Record<string, unknown>; summary: string }[] = [];
  for (const goal of closed) {
    if (goal.goal.dialect === COLOR_DIALECT_ID || goal.goal.dialect === MOTION_DIALECT_ID) {
      if (!visualTarget) {
        return null;
      }
      for (const action of goal.actions) {
        // Mirror the tier-0 APPLY-LOOK write rule: a clip that already carries a creative
        // look gets that effect UPDATED, not a duplicate stacked on top.
        const effectType = (action.params as { effectType?: string }).effectType;
        const existing =
          effectType === "creativeLook"
            ? (visualTarget.effects ?? []).find((effect) => effect.type === "creativeLook")
            : undefined;
        if (existing) {
          steps.push({
            actionId: "updateEffect",
            params: { layerId: visualTarget.id, effectId: existing.id, params: (action.params as { params?: unknown }).params ?? {} },
            summary: `${action.summary} (“${visualTarget.name}”)`
          });
        } else {
          steps.push({
            actionId: action.actionId,
            params: { layerId: visualTarget.id, ...action.params },
            summary: `${action.summary} (“${visualTarget.name}”)`
          });
        }
      }
      continue;
    }
    if (goal.goal.dialect === TEXT_DIALECT_ID) {
      for (const layer of textTargets) {
        for (const action of goal.actions) {
          steps.push({
            actionId: action.actionId,
            params: { layerId: layer.id, ...action.params },
            summary: `${action.summary} (“${layer.name}”)`
          });
        }
      }
      continue;
    }
    return null; // a dialect this binder doesn't know how to target — never half-apply
  }
  return steps.length > 0 ? brainPlan(prompt, steps) : null;
}

/** The explainability surface — honest provenance lines shown with the plan. */
function traceNotes(trace: MoodTrace): string[] {
  const notes: string[] = [];
  const facts = trace.factsConsulted
    .map((fact) => `${fact.id} (${fact.path === "cached" ? "cached" : "measured"})`)
    .join(", ");
  notes.push(facts.length > 0 ? `World Model consulted: ${facts} · 0 tokens` : `Structural evidence only · 0 tokens`);
  notes.push(...trace.notes);
  return notes;
}
