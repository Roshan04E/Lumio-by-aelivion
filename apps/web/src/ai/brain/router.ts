/**
 * Kimera Brain — the local router (B1 tier-0 reflex + B2 tier-1 command compiler). The entry
 * point every non-Talk prompt hits BEFORE any model or network: exact commands and registry
 * questions resolve at tier 0 (<5ms), grammar-parseable commands compile at tier 1 (<50ms) —
 * both zero tokens.
 *
 * PRECISION-FIRST, the brain's founding rule (AI_ARCHITECTURE.md): a handler fires only when the
 * parse is structurally complete — whole-string anchored match, target resolves uniquely, params
 * pass the action's own Zod schema. Anything less returns `escalate` SILENTLY and the normal
 * planner/loop takes over. A fast path that is sometimes wrong is worse than no fast path, so
 * never widen a pattern here without adding it to the router-eval corpus first (`brain:eval`).
 *
 * TRUST GATE (first slice of B6): every result carries a `ruleId`; the panel's 👍/👎 feedback
 * feeds feedback.ts, and a rule THIS user keeps rejecting fails `isRuleTrusted` and stops
 * firing — their prompts go to the model instead. Local intelligence that self-corrects.
 *
 * Mode gating is unchanged by design: a brain plan is an ordinary AiPlan that flows through the
 * SAME pipeline as an LLM plan (Professional still shows the approval bar; everything undoable).
 */

import type { TimelineComposition, TimelineLayer } from "@kimera-by-aelivion/shared";
import {
  actionCost,
  buildCapabilityIndex,
  computeLayerOrdinals,
  layerIdForOrdinal,
  resolveTargetLayer
} from "@kimera-by-aelivion/shared";
import type { AiPlan, PlanStep } from "../types";
import type { EditorCommandId } from "../../editor/editor-commands";
import { compileEditorCommand } from "./commands";
import { answerFaq } from "./faq";
import { isRuleTrusted } from "./feedback";
import { compileRule, type RuleStepInput } from "./rules";

export interface BrainContext {
  composition: TimelineComposition;
  /** Currently-selected layer ids. */
  selection: string[];
  /** Playhead time in seconds. */
  nowSeconds: number;
}

/** Which local tier resolved the prompt — the ledger's route label. */
export type BrainTier = "reflex" | "rules" | "semantic" | "world";

export type BrainRouteResult =
  | { kind: "plan"; plan: AiPlan; tier: BrainTier; ruleId: string }
  | { kind: "answer"; text: string; tier: BrainTier; ruleId: string }
  /** Editor command plane: view/transport control executed by the EditorPage dispatcher. */
  | { kind: "command"; commandId: EditorCommandId; params: unknown; ruleId: string; say: string }
  | { kind: "undo" }
  | { kind: "escalate" };

const ESCALATE: BrainRouteResult = { kind: "escalate" };

// ---------------------------------------------------------------------------
// Normalization + exact clip-phrase parsing
// ---------------------------------------------------------------------------

export function normalizePrompt(prompt: string): string {
  return normalize(prompt);
}

function normalize(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:hey |ok |okay )?(?:can you |could you |would you |will you )?(?:please )?/, "");
}

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

/**
 * Parse a phrase that is EXACTLY a clip reference and nothing else ("clip 3", "the 2nd layer",
 * "my third clip"). Stricter than shared `parseClipReference` (which finds a reference anywhere
 * in free text) — tier 0 must know the whole command was understood, not just a fragment.
 */
export function parseExactClipPhrase(phrase: string): number | undefined {
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

function findLayer(composition: TimelineComposition, layerId: string): TimelineLayer | undefined {
  for (const track of composition.tracks) {
    const found = track.layers.find((layer) => layer.id === layerId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function clipCount(composition: TimelineComposition): number {
  return computeLayerOrdinals(composition).size;
}

// ---------------------------------------------------------------------------
// Plan building — brain plans are ordinary AiPlans (same gating as LLM plans)
// ---------------------------------------------------------------------------

/** Build a brain plan, or null when any step fails its action's own Zod schema (→ escalate). */
export function brainPlan(prompt: string, stepInputs: RuleStepInput[]): AiPlan | null {
  const index = buildCapabilityIndex();
  const steps: PlanStep[] = [];
  for (const input of stepInputs) {
    const validation = index.validateActionParams(input.actionId, input.params);
    if (!validation.ok) {
      return null;
    }
    steps.push({
      id: `reflex_${steps.length}_${Math.random().toString(36).slice(2, 8)}`,
      kind: "timelineAction",
      summary: input.summary,
      actionId: input.actionId,
      params: input.params,
      cost: actionCost()
    });
  }
  return {
    id: `plan_reflex_${Math.random().toString(36).slice(2, 10)}`,
    prompt,
    steps,
    totalCredits: 0,
    confidence: "Exact",
    notes: [],
    provider: "brain"
  };
}

/** Trust gate: a rule this user keeps 👎-ing stops firing (escalates instead). */
function gated(result: BrainRouteResult, ruleId: string): BrainRouteResult {
  return isRuleTrusted(ruleId) ? result : ESCALATE;
}

function reflexAnswer(text: string, ruleId: string): BrainRouteResult {
  return gated({ kind: "answer", text, tier: "reflex", ruleId }, ruleId);
}

// ---------------------------------------------------------------------------
// Tier-0 command handlers
// ---------------------------------------------------------------------------

const UNDO_RE = /^(?:undo(?: (?:that|this|it))?|undo (?:the )?last (?:edit|change|action)|revert (?:that|the last (?:edit|change|action)))$/;

const DESCRIBE_CLIP_RE = /^(?:what(?:'s| is)|describe|tell me about) (?:my |the |in |on )*(.+?)\s*\??$/;

const ADD_MARKER_RE = /^(?:add|drop|place|set) a marker(?: (?:at|on) (?:the )?(?:playhead|current time))?(?: here)?$/;

const DELETE_CLIP_RE = /^(?:delete|remove) (.+)$/;
/** Ripple variants: "ripple delete clip 2", "delete clip 2 and close the gap". */
const RIPPLE_DELETE_RE = /^ripple[- ]?(?:delete|remove) (.+)$|^(?:delete|remove) (.+?) and (?:close|fill) the gap$/;

const SPLIT_TARGETED_RE = /^(?:split|cut) (.+?) (?:at|on) (?:the )?playhead$/;
const SPLIT_HERE_RE = /^(?:split|cut)(?: (?:the |my )?(?:selected |this )?clip)? (?:at|on) (?:the )?playhead$/;

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}

function describeClip(context: BrainContext, phrase: string): BrainRouteResult {
  const ordinal = parseExactClipPhrase(phrase);
  if (!ordinal) {
    return ESCALATE;
  }
  const layerId = layerIdForOrdinal(context.composition, ordinal);
  const layer = layerId ? findLayer(context.composition, layerId) : undefined;
  if (!layer) {
    return reflexAnswer(
      `There's no clip ${ordinal} on the timeline — I count ${clipCount(context.composition)} clip(s) right now.`,
      "t0.describe-clip"
    );
  }
  const effects = (layer.effects ?? []).map((effect) => effect.type);
  const lines = [
    `**Clip ${ordinal}** — ${layer.name ?? layer.type}`,
    `- Type: ${layer.type}`,
    `- Timing: ${formatSeconds(layer.startSeconds)} → ${formatSeconds(layer.startSeconds + layer.durationSeconds)} (${formatSeconds(layer.durationSeconds)} long)`,
    effects.length > 0 ? `- Effects: ${effects.join(", ")}` : "- Effects: none"
  ];
  return reflexAnswer(lines.join("\n"), "t0.describe-clip");
}

function deleteClip(context: BrainContext, prompt: string, phrase: string, ripple = false): BrainRouteResult {
  const ordinal = parseExactClipPhrase(phrase);
  if (!ordinal) {
    // "remove the blur", "delete this" etc. are NOT tier-0 material (effect/vague-target
    // taxonomy lives in the planners + delete guard) — escalate untouched.
    return ESCALATE;
  }
  const layerId = layerIdForOrdinal(context.composition, ordinal);
  if (!layerId) {
    return reflexAnswer(
      `There's no clip ${ordinal} to delete — I count ${clipCount(context.composition)} clip(s) on the timeline.`,
      "t0.delete-clip"
    );
  }
  const plan = brainPlan(prompt, [
    {
      actionId: "deleteLayer",
      params: { layerId, ...(ripple ? { ripple: true } : {}) },
      summary: ripple ? `Ripple delete clip ${ordinal} (close the gap)` : `Delete clip ${ordinal}`
    }
  ]);
  return plan ? gated({ kind: "plan", plan, tier: "reflex", ruleId: "t0.delete-clip" }, "t0.delete-clip") : ESCALATE;
}

function splitAtPlayhead(context: BrainContext, prompt: string, phrase: string | undefined): BrainRouteResult {
  let layerId: string | undefined;
  let label: string;
  if (phrase !== undefined) {
    const ordinal = parseExactClipPhrase(phrase);
    if (!ordinal) {
      return ESCALATE;
    }
    layerId = layerIdForOrdinal(context.composition, ordinal);
    if (!layerId) {
      return reflexAnswer(
        `There's no clip ${ordinal} on the timeline — I count ${clipCount(context.composition)} clip(s).`,
        "t0.split-playhead"
      );
    }
    label = `clip ${ordinal}`;
  } else {
    const resolved = resolveTargetLayer(context.composition, {
      selection: context.selection,
      nowSeconds: context.nowSeconds
    });
    // Precision rule: only a UNIQUE target may fast-path. Ambiguous/none → the planners clarify.
    if (!resolved.layerId || (resolved.reason !== "selection" && resolved.reason !== "playhead")) {
      return ESCALATE;
    }
    layerId = resolved.layerId;
    label = resolved.reason === "selection" ? "the selected clip" : "the clip under the playhead";
  }

  const layer = findLayer(context.composition, layerId);
  if (!layer) {
    return ESCALATE;
  }
  const local = context.nowSeconds - layer.startSeconds;
  if (local <= 0 || local >= layer.durationSeconds) {
    return reflexAnswer(
      `The playhead (${formatSeconds(context.nowSeconds)}) isn't inside ${label} (${formatSeconds(layer.startSeconds)} → ${formatSeconds(layer.startSeconds + layer.durationSeconds)}) — move it over the clip and try again.`,
      "t0.split-playhead"
    );
  }
  const plan = brainPlan(prompt, [
    {
      actionId: "splitClip",
      params: { layerId, atSeconds: context.nowSeconds },
      summary: `Split ${label} at the playhead (${formatSeconds(context.nowSeconds)})`
    }
  ]);
  return plan ? gated({ kind: "plan", plan, tier: "reflex", ruleId: "t0.split-playhead" }, "t0.split-playhead") : ESCALATE;
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * Try to resolve a prompt locally (tier 0, then tier 1). Returns `escalate` for EVERYTHING it
 * isn't near-certain about — the caller then runs the normal planner/agent-loop path.
 */
export function routePrompt(prompt: string, context: BrainContext): BrainRouteResult {
  const text = normalize(prompt);
  if (!text || text.length > 160) {
    return ESCALATE;
  }

  // ---- Tier 0: reflex ----
  if (UNDO_RE.test(text)) {
    return { kind: "undo" };
  }

  // Editor command plane ("pan mode", "pause", "select clip 3") — checked BEFORE the FAQ so
  // control phrases EXECUTE instead of answering with a shortcut tip. Trust-gated like all rules.
  const cmd = compileEditorCommand(text, context);
  if (cmd) {
    if (cmd.kind === "answer") {
      return reflexAnswer(cmd.text, cmd.ruleId);
    }
    return gated({ kind: "command", commandId: cmd.commandId, params: cmd.params, ruleId: cmd.ruleId, say: cmd.say }, cmd.ruleId);
  }

  const faq = answerFaq(text);
  if (faq) {
    return reflexAnswer(faq.text, `t0.faq.${faq.matched}`);
  }

  if (ADD_MARKER_RE.test(text)) {
    const plan = brainPlan(prompt, [
      {
        actionId: "addMarker",
        params: { timeSeconds: context.nowSeconds },
        summary: `Add a marker at the playhead (${formatSeconds(context.nowSeconds)})`
      }
    ]);
    if (plan) {
      return gated({ kind: "plan", plan, tier: "reflex", ruleId: "t0.add-marker" }, "t0.add-marker");
    }
  }

  const describe = DESCRIBE_CLIP_RE.exec(text);
  if (describe) {
    const result = describeClip(context, describe[1]!);
    if (result.kind !== "escalate") {
      return result;
    }
  }

  const targetedSplit = SPLIT_TARGETED_RE.exec(text);
  if (targetedSplit && !/^(?:the |my )?(?:selected |this )?clip$/.test(targetedSplit[1]!)) {
    const result = splitAtPlayhead(context, prompt, targetedSplit[1]!);
    if (result.kind !== "escalate") {
      return result;
    }
  } else if (SPLIT_HERE_RE.test(text)) {
    const result = splitAtPlayhead(context, prompt, undefined);
    if (result.kind !== "escalate") {
      return result;
    }
  }

  const rippleDel = RIPPLE_DELETE_RE.exec(text);
  if (rippleDel) {
    const result = deleteClip(context, prompt, (rippleDel[1] ?? rippleDel[2])!, true);
    if (result.kind !== "escalate") {
      return result;
    }
  }

  const del = DELETE_CLIP_RE.exec(text);
  if (del) {
    const result = deleteClip(context, prompt, del[1]!);
    if (result.kind !== "escalate") {
      return result;
    }
  }

  // ---- Tier 1: command compiler (B2) ----
  const compiled = compileRule(text, context);
  if (compiled && isRuleTrusted(compiled.ruleId)) {
    const plan = brainPlan(prompt, compiled.steps);
    if (plan) {
      return { kind: "plan", plan, tier: "rules", ruleId: compiled.ruleId };
    }
  }

  return ESCALATE;
}
