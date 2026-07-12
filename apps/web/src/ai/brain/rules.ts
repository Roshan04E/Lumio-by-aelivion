/**
 * Lumio Brain — tier-1 Command Compiler (B2). A grammar, not a guesser: verb family + target +
 * params → registry action(s), compiled locally in <50ms for zero tokens.
 *
 * PRECISION CONTRACT (same as tier 0, see router.ts): a rule fires ONLY when the parse is
 * structurally complete — the whole sentence matched, the target resolves UNIQUELY (explicit
 * clip reference → single selection → single clip under playhead), params are exact (a color
 * phrase must BE a color, a duration must BE a number), and the target's layer TYPE fits the
 * action (text color only on text layers — a video "to white" is grade territory, escalate).
 * Anything less returns null silently and the model takes over.
 *
 * Every rule carries a stable `ruleId` — the 👍/👎 feedback trust in feedback.ts is keyed on it,
 * so a rule THIS user keeps rejecting stops firing for them (checked in router.ts).
 */

import type { TimelineComposition, TimelineLayer } from "@lumio-by-aelivion/shared";
import { layerIdForOrdinal, resolveTargetLayer } from "@lumio-by-aelivion/shared";
import { extractColor } from "../planner/entities";

export interface RuleStepInput {
  actionId: string;
  params: unknown;
  summary: string;
}

export interface CompiledRule {
  ruleId: string;
  steps: RuleStepInput[];
}

export interface RuleContext {
  composition: TimelineComposition;
  selection: string[];
  nowSeconds: number;
}

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10
};

/** A phrase that is EXACTLY a clip reference ("clip 3", "the 2nd layer") → its ordinal. */
function parseExactClipPhrase(phrase: string): number | undefined {
  const rest = phrase.replace(/^(?:the|my)\s+/, "").trim();
  const numeric = /^(?:clip|layer)\s*(?:#|number\s*)?(\d{1,3})$/.exec(rest);
  if (numeric) {
    return Number(numeric[1]) || undefined;
  }
  const nth = /^(\d{1,3})(?:st|nd|rd|th)\s+(?:clip|layer)$/.exec(rest);
  if (nth) {
    return Number(nth[1]) || undefined;
  }
  const word = /^([a-z]+)\s+(?:clip|layer)$/.exec(rest);
  if (word) {
    return ORDINAL_WORDS[word[1]!];
  }
  return undefined;
}

/** Pronoun/deixis target phrases that point at the current selection/playhead clip. */
const DEIXIS_RE = /^(?:it|this|that|this clip|that clip|the (?:selected )?(?:clip|layer))$/;
/** "the text" / "the title" ("the" may already be consumed by the rule's own pattern) —
 * resolvable when the timeline has exactly one text layer, or the selection is a text layer. */
const THE_TEXT_RE = /^(?:the )?(?:text|title|caption)$/;

interface ResolvedTarget {
  layer: TimelineLayer;
  /** Human label for step summaries ("clip 3", "the selected clip"). */
  label: string;
}

function findLayer(composition: TimelineComposition, layerId: string): TimelineLayer | undefined {
  for (const track of composition.tracks) {
    const found = track.layers.find((layer) => layer.id === layerId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function allLayersOfType(composition: TimelineComposition, type: TimelineLayer["type"]): TimelineLayer[] {
  return composition.tracks.flatMap((track) => track.layers.filter((layer) => layer.type === type));
}

/**
 * Resolve a matched target phrase to ONE layer, or undefined. Priority mirrors the shared
 * clip-reference ladder; "ambiguous" never resolves (precision contract).
 */
function resolveTarget(phrase: string, context: RuleContext): ResolvedTarget | undefined {
  const normalized = phrase.trim();

  const ordinal = parseExactClipPhrase(normalized);
  if (ordinal !== undefined) {
    const layerId = layerIdForOrdinal(context.composition, ordinal);
    const layer = layerId ? findLayer(context.composition, layerId) : undefined;
    return layer ? { layer, label: `clip ${ordinal}` } : undefined;
  }

  if (THE_TEXT_RE.test(normalized)) {
    const textLayers = allLayersOfType(context.composition, "text");
    if (textLayers.length === 1) {
      return { layer: textLayers[0]!, label: "the text layer" };
    }
    // Several text layers → fall through to selection/playhead below (an explicit selection
    // still disambiguates); otherwise not unique → decline.
    const resolved = resolveTargetLayer(context.composition, { selection: context.selection, nowSeconds: context.nowSeconds });
    if (resolved.reason === "selection" && resolved.layerId) {
      const layer = findLayer(context.composition, resolved.layerId);
      return layer && layer.type === "text" ? { layer, label: "the selected text" } : undefined;
    }
    return undefined;
  }

  if (DEIXIS_RE.test(normalized)) {
    const resolved = resolveTargetLayer(context.composition, { selection: context.selection, nowSeconds: context.nowSeconds });
    if (!resolved.layerId || (resolved.reason !== "selection" && resolved.reason !== "playhead")) {
      return undefined;
    }
    const layer = findLayer(context.composition, resolved.layerId);
    return layer
      ? { layer, label: resolved.reason === "selection" ? "the selected clip" : "the clip under the playhead" }
      : undefined;
  }

  return undefined;
}

/**
 * A phrase that IS a color and nothing else ("white", "dark red", "#ff00aa") — extractColor
 * finds colors anywhere in free text, so additionally require every word to be color vocabulary.
 */
function parseExactColorPhrase(phrase: string): string | undefined {
  const rest = phrase.trim();
  const color = extractColor(rest);
  if (!color) {
    return undefined;
  }
  const leftover = rest
    .toLowerCase()
    .replace(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i, " ")
    .replace(/\b(neutral|warm|cool|dark|light|bright|deep|pale|soft|muted|vivid|rich|dull|faded)\b/g, " ")
    .replace(/\b[a-z]+\b/g, (word) => (extractColor(word) ? " " : word))
    .trim();
  return leftover === "" ? color : undefined;
}

const NUMBER = "(\\d{1,4}(?:\\.\\d+)?)";
const SECONDS = "(?:s|sec|secs|second|seconds)";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Rule = (text: string, context: RuleContext) => CompiledRule | null;

/** "change (the) (text) color of clip 3 to white" / "make clip 2 white" / "set its color to #fff". */
const textColor: Rule = (text, context) => {
  const build = (targetPhrase: string, colorPhrase: string): CompiledRule | null => {
    const color = parseExactColorPhrase(colorPhrase);
    if (!color) {
      return null;
    }
    const target = resolveTarget(targetPhrase, context);
    // TYPE GATE: only text layers take a text color. "make clip 1 white" on a video is a
    // color-grade ask — the model (and the grade skill) own that; never guess here.
    if (!target || target.layer.type !== "text") {
      return null;
    }
    return {
      ruleId: "t1.text-color",
      steps: [
        {
          actionId: "updateText",
          params: { layerId: target.layer.id, color },
          summary: `Change ${target.label} text color to ${color}`
        }
      ]
    };
  };

  let match = /^(?:please )?(?:change|set|update|switch) (?:the )?(?:text )?colou?r of (.+?) to (.+)$/.exec(text);
  if (match) {
    return build(match[1]!, match[2]!);
  }
  match = /^(?:please )?(?:change|set|update) (.+?)(?:'s)? (?:text )?colou?r to (.+)$/.exec(text);
  if (match) {
    return build(match[1]!, match[2]!);
  }
  // "make clip 2 white" / "turn the title red" / "change clip 2 to white". The color phrase is
  // a 1–3 word suffix; a lazy regex would commit to the wrong split ("clip" | "2 white"), so try
  // every suffix split explicitly and let the color/target validators pick the structural one.
  match = /^(?:please )?(?:make|turn|recolou?r|colou?r|change|set) (?:the )?(?:text (?:of|on|in) )?(.+)$/.exec(text);
  if (match) {
    const words = match[1]!.split(" ");
    for (let suffix = 1; suffix <= Math.min(3, words.length - 1); suffix += 1) {
      const colorPhrase = words.slice(-suffix).join(" ");
      const targetPhrase = words
        .slice(0, words.length - suffix)
        .join(" ")
        .replace(/ to$/, "");
      const compiled = build(targetPhrase, colorPhrase);
      if (compiled) {
        return compiled;
      }
    }
  }
  return null;
};

/** "move clip 3 5 seconds earlier/later" / "delay clip 2 by 3 seconds" / "push it 2s later". */
const moveInTime: Rule = (text, context) => {
  const build = (targetPhrase: string, amount: string, direction: "earlier" | "later"): CompiledRule | null => {
    const seconds = Number(amount);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
      return null;
    }
    const target = resolveTarget(targetPhrase, context);
    if (!target) {
      return null;
    }
    const deltaSeconds = direction === "earlier" ? -seconds : seconds;
    return {
      ruleId: "t1.move-time",
      steps: [
        {
          actionId: "moveLayer",
          params: { layerId: target.layer.id, deltaSeconds },
          summary: `Move ${target.label} ${seconds}s ${direction}`
        }
      ]
    };
  };

  let match = new RegExp(
    `^(?:please )?(?:move|shift) (.+?) (?:by )?${NUMBER} ?${SECONDS} (earlier|later|left|right|back|backwards?|forwards?|ahead)$`
  ).exec(text);
  if (match) {
    const word = match[3]!;
    const direction = /^(earlier|left|back|backwards?)$/.test(word) ? "earlier" : "later";
    return build(match[1]!, match[2]!, direction);
  }
  match = new RegExp(`^(?:please )?(?:delay|push) (.+?) (?:by )?${NUMBER} ?${SECONDS}$`).exec(text);
  if (match) {
    return build(match[1]!, match[2]!, "later");
  }
  match = new RegExp(`^(?:please )?start (.+?) ${NUMBER} ?${SECONDS} (earlier|later)$`).exec(text);
  if (match) {
    return build(match[1]!, match[2]!, match[3] as "earlier" | "later");
  }
  return null;
};

/** "fade in clip 2" / "add a fade out to clip 3 over 2 seconds" / "fade in and out clip 1". */
const fade: Rule = (text, context) => {
  const build = (kinds: ("fadeIn" | "fadeOut")[], targetPhrase: string, duration?: string): CompiledRule | null => {
    const target = resolveTarget(targetPhrase, context);
    if (!target) {
      return null;
    }
    const durationSeconds = duration !== undefined ? Number(duration) : undefined;
    if (durationSeconds !== undefined && !(durationSeconds >= 0.05 && durationSeconds <= 10)) {
      return null;
    }
    return {
      ruleId: "t1.fade",
      steps: kinds.map((kind) => ({
        actionId: "addTransition",
        params: {
          layerId: target.layer.id,
          kind,
          ...(durationSeconds !== undefined ? { durationSeconds } : {})
        },
        summary: `${kind === "fadeIn" ? "Fade in" : "Fade out"} ${target.label}${durationSeconds !== undefined ? ` over ${durationSeconds}s` : ""}`
      }))
    };
  };

  const OVER = `(?: over ${NUMBER} ?${SECONDS})?`;
  let match = new RegExp(`^(?:please )?fade (in and out|out and in|in|out) (.+?)${OVER}$`).exec(text);
  if (!match) {
    match = new RegExp(`^(?:please )?(?:add )?(?:a )?fade[- ]?(in|out)(?: to| on| for)? (.+?)${OVER}$`).exec(text);
  }
  if (match) {
    const which = match[1]!;
    const kinds: ("fadeIn" | "fadeOut")[] =
      which === "in" ? ["fadeIn"] : which === "out" ? ["fadeOut"] : ["fadeIn", "fadeOut"];
    return build(kinds, match[2]!, match[3]);
  }
  return null;
};

/** "blur clip 2" / "add a blur to clip 3" / "set (the) blur on clip 2 to 12". */
const blur: Rule = (text, context) => {
  const withTarget = (targetPhrase: string, amount?: number): CompiledRule | null => {
    const target = resolveTarget(targetPhrase, context);
    if (!target) {
      return null;
    }
    if (amount !== undefined && !(amount >= 0 && amount <= 100)) {
      return null;
    }
    const existing = (target.layer.effects ?? []).find((effect) => effect.type === "blur");
    if (existing && amount !== undefined) {
      // Real compiler behavior: an existing blur is UPDATED, not stacked.
      return {
        ruleId: "t1.blur",
        steps: [
          {
            actionId: "updateEffect",
            params: { layerId: target.layer.id, effectId: existing.id, params: { amount } },
            summary: `Set blur on ${target.label} to ${amount}`
          }
        ]
      };
    }
    if (existing) {
      // "blur clip 2" when it's already blurred: nothing structurally certain to do — escalate.
      return null;
    }
    return {
      ruleId: "t1.blur",
      steps: [
        {
          actionId: "addEffect",
          params: {
            layerId: target.layer.id,
            effectType: "blur",
            ...(amount !== undefined ? { params: { amount } } : {})
          },
          summary: `Blur ${target.label}${amount !== undefined ? ` (amount ${amount})` : ""}`
        }
      ]
    };
  };

  let match = new RegExp(`^(?:please )?set (?:the )?blur (?:of|on) (.+?) to ${NUMBER}$`).exec(text);
  if (match) {
    return withTarget(match[1]!, Number(match[2]));
  }
  match = new RegExp(`^(?:please )?(?:add )?(?:a )?blur (?:to|on) (.+?)(?: (?:with|at) (?:amount |strength )?${NUMBER})?$`).exec(text);
  if (match) {
    return withTarget(match[1]!, match[2] !== undefined ? Number(match[2]) : undefined);
  }
  match = /^(?:please )?blur (.+)$/.exec(text);
  if (match) {
    return withTarget(match[1]!);
  }
  return null;
};

const RULES: Rule[] = [textColor, moveInTime, fade, blur];

/**
 * Compile a normalized prompt into registry steps, or null when no rule is structurally
 * certain. The router owns the trust gate (feedback.ts) and Zod re-validation.
 */
export function compileRule(text: string, context: RuleContext): CompiledRule | null {
  for (const rule of RULES) {
    const compiled = rule(text, context);
    if (compiled) {
      return compiled;
    }
  }
  return null;
}
