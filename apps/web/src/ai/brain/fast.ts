/**
 * Orreris Brain — tier-3 Transactional LLM (B4). For prompts that LOOK like a single edit
 * command but tiers 0–2 couldn't parse: ONE call to the gateway's `fast` class (small
 * non-reasoning instruct models, temperature 0) with a micro context — the target clip only
 * plus a compact action catalog — instead of a full agent-loop run with reasoning models.
 *
 * Precision is preserved differently from the local tiers: the model may only SELECT among
 * registry actions, its reply is Zod-validated per step via `brainPlan`, and it is told to
 * `escalate` on anything creative/ambiguous — a bad reply costs one cheap call and falls
 * through to the loop, never a wrong edit. The `looksTransactional` gate keeps this tier off
 * the creative path so loop runs don't pay a wasted extra call.
 */

import type { TimelineComposition, TimelineLayer } from "@orreris/shared";
import { buildCapabilityIndex, computeLayerOrdinals, describeZodShape, parseClipReference } from "@orreris/shared";
import type { AiPlan } from "../types";
import { brainPlan, normalizePrompt, type BrainContext } from "./router";
import { isRuleTrusted } from "./feedback";

// `import.meta.env` is Vite-only — guard so brain:eval can import this module under node/tsx.
const API_URL =
  ((import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL as string | undefined) ??
  "http://localhost:4100/api";

/** The whole tier is 👎-gated as one unit — a user the fast lane keeps failing gets it off. */
export const FAST_LANE_RULE_ID = "t3.fast-lane";

export interface FastRouteResult {
  kind: "plan" | "escalate";
  plan?: AiPlan;
  provider?: string | undefined;
  /** Rough request tokens (payload chars / 4) for the ledger. */
  estTokens: number;
}

const ESCALATE = (estTokens = 0): FastRouteResult => ({ kind: "escalate", estTokens });

// ---------------------------------------------------------------------------
// The economic gate: only single edit-like commands are worth the extra call
// ---------------------------------------------------------------------------

const ACTION_VERBS =
  /^(?:add|put|insert|create|draw|write|make|set|change|update|turn|move|shift|nudge|slide|push|pull|delay|delete|remove|drop|trim|split|cut|chop|slice|fade|blur|sharpen|resize|scale|rotate|flip|center|align|recolou?r|colou?r|rename|duplicate|copy|swap|replace|mute|unmute|hide|show|lower|raise|speed|slow|reverse|group|ungroup|link|unlink|extend|shorten|stretch|shrink)\b/;

/** Creative/tool territory the fast tier must never claim — the loop owns these. */
const CREATIVE_RE =
  /\b(?:cinematic|dramatic|aesthetic|vibe|mood|pop|cool|dreamy|vintage|retro|moody|epic|beautiful|story|montage|edit this video|grade|grading|color ?correct|captions?|subtitles?|transcribe|track|tracking|background removal|remove (?:the )?background|green ?screen|beat|music|generate|stabiliz)\b/i;

/**
 * Should this prompt try the fast lane? Short, starts with an action verb, single-clause,
 * and not creative/tool territory. Misses just take the normal loop path.
 */
export function looksTransactional(prompt: string): boolean {
  const text = normalizePrompt(prompt);
  if (!text || text.length > 90) {
    return false;
  }
  if (!ACTION_VERBS.test(text)) {
    return false;
  }
  if (CREATIVE_RE.test(text)) {
    return false;
  }
  // Compound requests ("delete clip 2 and add a title") are loop material.
  if (/\b(?:and then|then|and)\b/.test(text) && !/\bfade in and out\b/.test(text)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Micro context — the target clip only, never the whole timeline
// ---------------------------------------------------------------------------

interface SliceLayer {
  ref: string;
  id: string;
  type: string;
  name: string | undefined;
  startSeconds: number;
  durationSeconds: number;
  text?: string | undefined;
  effects?: { id: string; type: string }[] | undefined;
}

function sliceLayer(layer: TimelineLayer, ref: string): SliceLayer {
  const effects = (layer.effects ?? []).map((effect) => ({ id: effect.id, type: effect.type }));
  const text = (layer as { text?: string }).text;
  return {
    ref,
    id: layer.id,
    type: layer.type,
    name: layer.name,
    startSeconds: layer.startSeconds,
    durationSeconds: layer.durationSeconds,
    ...(typeof text === "string" ? { text: text.slice(0, 80) } : {}),
    ...(effects.length > 0 ? { effects } : {})
  };
}

/** Explicit clip reference → that layer; else selection; else clips under the playhead (≤3). */
function buildMicroContext(prompt: string, context: BrainContext): string {
  const ordinals = computeLayerOrdinals(context.composition);
  const byId = new Map<string, TimelineLayer>();
  for (const track of context.composition.tracks) {
    for (const layer of track.layers) {
      byId.set(layer.id, layer);
    }
  }
  const refOf = (layerId: string): string => {
    const entry = ordinals.get(layerId);
    return entry ? `clip ${entry.ordinal}` : layerId;
  };

  const picked: TimelineLayer[] = [];
  const reference = parseClipReference(normalizePrompt(prompt));
  if (reference?.ordinal !== undefined) {
    for (const [layerId, entry] of ordinals) {
      if (entry.ordinal === reference.ordinal) {
        const layer = byId.get(layerId);
        if (layer) {
          picked.push(layer);
        }
      }
    }
  }
  if (picked.length === 0) {
    for (const layerId of context.selection) {
      const layer = byId.get(layerId);
      if (layer && picked.length < 2) {
        picked.push(layer);
      }
    }
  }
  if (picked.length === 0) {
    for (const layer of byId.values()) {
      const inRange = context.nowSeconds >= layer.startSeconds && context.nowSeconds < layer.startSeconds + layer.durationSeconds;
      if (inRange && picked.length < 3) {
        picked.push(layer);
      }
    }
  }

  const lines = [
    `playhead: ${context.nowSeconds.toFixed(2)}s of ${context.composition.durationSeconds}s (${context.composition.width}x${context.composition.height})`,
    ...picked.map((layer) => JSON.stringify(sliceLayer(layer, refOf(layer.id))))
  ];
  return lines.join("\n");
}

/** Compact action catalog: id + param hints, one line each (no tools/skills — actions only). */
let cachedActionCatalog: string | null = null;
function actionCatalog(): string {
  if (cachedActionCatalog) {
    return cachedActionCatalog;
  }
  const index = buildCapabilityIndex();
  const effectTypes = index.effects.map((effect) => effect.type).join("|");
  cachedActionCatalog = [
    ...index.actions.map((action) => {
      // Web has no direct zod dep — borrow the param type from the shared helper's signature.
      const params = describeZodShape(action.inputSchema as Parameters<typeof describeZodShape>[0]);
      return `- ${action.id}${params ? `: ${params}` : ""}`;
    }),
    `effectType values for addEffect: ${effectTypes}`
  ].join("\n");
  return cachedActionCatalog;
}

// ---------------------------------------------------------------------------
// The tier-3 route
// ---------------------------------------------------------------------------

interface FastPlanResponse {
  data?: {
    available?: boolean;
    escalate?: boolean;
    provider?: string;
    steps?: { actionId: string; params?: unknown; summary?: string }[];
  };
}

/**
 * One fast-class gateway call; returns a fully Zod-validated brain plan or escalates. Never
 * throws — any failure (offline, timeout, bad JSON, invalid params) falls through to the loop.
 */
export async function routePromptFast(prompt: string, context: BrainContext): Promise<FastRouteResult> {
  if (!looksTransactional(prompt) || !isRuleTrusted(FAST_LANE_RULE_ID)) {
    return ESCALATE();
  }
  const body = JSON.stringify({
    prompt: normalizePrompt(prompt),
    actions: actionCatalog(),
    context: buildMicroContext(prompt, context)
  });
  const estTokens = Math.round(body.length / 4);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(`${API_URL}/ai/plan/fast`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      return ESCALATE(estTokens);
    }
    const json = (await response.json()) as FastPlanResponse;
    const steps = json.data?.steps;
    if (!json.data?.available || json.data.escalate || !steps || steps.length === 0) {
      return ESCALATE(estTokens);
    }
    // Same trust boundary as every brain plan: each step must pass its action's own Zod schema.
    const plan = brainPlan(
      prompt,
      steps.map((step) => ({
        actionId: step.actionId,
        params: step.params ?? {},
        summary: step.summary?.trim() || step.actionId
      }))
    );
    if (!plan) {
      return ESCALATE(estTokens);
    }
    return {
      kind: "plan",
      plan: { ...plan, confidence: "High Quality", ...(json.data.provider ? { provider: json.data.provider } : {}) },
      provider: json.data.provider,
      estTokens
    };
  } catch {
    return ESCALATE(estTokens);
  }
}
