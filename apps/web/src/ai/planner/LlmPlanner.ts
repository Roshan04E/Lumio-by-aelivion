import {
  actionCost,
  buildCapabilityIndex,
  buildPlannerUserContent,
  classifyToolCost,
  extractPlanJson,
  logUnsupported,
  PLANNER_SYSTEM_PROMPT,
  recordEffectDemand,
  recordToolDemand
} from "@reelforge/shared";
import { loadByoKey } from "../byok";
import { isOllamaLocalActive, loadOllamaConfig, streamOllamaChat } from "../ollama";
import type { AiPlan, PlanEventHandler, PlanStep, PlannerContext, PlannerProvider } from "../types";
import { extractColor, extractSize, extractTextStyle, resolveShapeGeometry } from "./entities";

/**
 * P8 / GP2.1 — real LLM planner. Implements the same `PlannerProvider` contract as
 * the deterministic planner, so the executor and UI don't change. It STREAMS from
 * the backend gateway (`/ai/plan/stream`, NDJSON) so reasoning/phases render live,
 * then *validates every returned step against the live registries* before trusting
 * it — the model may only select tools/actions Lumio already has.
 *
 * Any failure (no provider, network error, empty/invalid plan) transparently falls
 * back to the injected deterministic planner, so the editor is never blocked.
 */

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4100/api";

interface RawPlan {
  steps?: unknown;
  confidence?: unknown;
  notes?: unknown;
}

interface StreamedPlan {
  plan: RawPlan;
  provider?: string | undefined;
  reasoning?: string | undefined;
}

/** Map the model's numeric confidence (0–1) to the display label (raw % is shown alongside). */
function labelForPercent(percent: number): AiPlan["confidence"] {
  if (percent >= 85) return "Exact";
  if (percent >= 65) return "High Quality";
  if (percent >= 45) return "Approximation";
  return "Experimental";
}

let llmStepCounter = 0;
function stepId(): string {
  llmStepCounter += 1;
  return `lstep_${Date.now().toString(36)}_${llmStepCounter}`;
}

export class LlmPlanner implements PlannerProvider {
  readonly id = "llm";

  constructor(private readonly fallback: PlannerProvider) {}

  async plan(prompt: string, ctx: PlannerContext, onEvent?: PlanEventHandler): Promise<AiPlan> {
    const index = buildCapabilityIndex();

    // Phases 0–2 are real, fast client steps (understand → build slice → read registry).
    onEvent?.({ type: "phase", index: 0 });
    const byo = loadByoKey();
    const capabilities = index.describeForPlanner();
    const context = summarizeContext(ctx);
    const history = (ctx.history ?? []).slice(-8);
    const images = ctx.referenceImages?.length ? ctx.referenceImages : undefined;
    const payload = {
      prompt,
      capabilities,
      context,
      history,
      ...(byo ? { byo } : {}),
      // GP4 — "Best Quality" opts into the shared paid Claude hop (server uses it only if a key is set).
      ...(ctx.memory?.qualityMode === "best" ? { premium: true } : {}),
      // Reference image(s) → routed server-side to a vision-capable provider.
      ...(images ? { images } : {})
    };
    onEvent?.({ type: "phase", index: 1 });
    onEvent?.({ type: "phase", index: 2 });

    let streamed: StreamedPlan | "unavailable" | null = null;

    // Local mode (Ollama): plan against the user's local model, browser-direct. The chat panel only
    // sets `useLocalLlm` after a successful ping, so we attempt it first; any failure (or unparseable
    // reply) leaves `streamed` null and falls through to the cloud gateway below.
    const localConfig = ctx.useLocalLlm && isOllamaLocalActive() ? loadOllamaConfig() : null;
    if (localConfig) {
      try {
        streamed = await this.streamLocal(buildPlannerUserContent({ prompt, capabilities, context, history }), images, localConfig, onEvent);
      } catch {
        streamed = null;
      }
    }

    if (streamed === null) {
      try {
        streamed = await this.streamRequest(payload, onEvent);
      } catch {
        streamed = null;
      }
    }

    // No provider, exhausted pool, or transport error → deterministic fallback,
    // with an honest nudge so heavy/multi-user load self-offloads to BYO/Pro (P16).
    if (streamed === "unavailable" || streamed === null) {
      return this.fallbackWithNudge(prompt, ctx, onEvent);
    }

    const built = this.buildPlan(prompt, streamed, index, onEvent, ctx.composition);
    if (built.plan) {
      return built.plan;
    }

    // One bounded agentic repair: if the model proposed steps but they failed
    // param-level validation, hand the errors back ONCE for a corrected plan.
    if (built.dropped.length > 0 && Array.isArray(streamed.plan.steps)) {
      const repaired = await this.attemptRepair(prompt, payload, streamed.plan.steps, built.dropped, index, onEvent, ctx.composition);
      if (repaired) {
        return repaired;
      }
    }

    logUnsupported({ prompt, missingCapability: "llm-no-valid-steps", acceptedApproximation: false });
    return this.fallback.plan(prompt, ctx, onEvent);
  }

  /**
   * Deterministic fallback used when the shared LLM pool is unavailable/exhausted.
   * Appends a one-line nudge so users on the busy free pool know to bring their own
   * key or enable Pro — the practical multi-user scaling path (P16). Skipped when a
   * BYO key is set (they're already off the shared pool).
   */
  private async fallbackWithNudge(prompt: string, ctx: PlannerContext, onEvent: PlanEventHandler | undefined): Promise<AiPlan> {
    const plan = await this.fallback.plan(prompt, ctx, onEvent);
    if (loadByoKey()) {
      return plan;
    }
    const nudge = "Planned offline — the shared AI pool is busy or rate-limited. Add your own key (🔑) or turn on Pro for full-quality planning.";
    return plan.notes.includes(nudge) ? plan : { ...plan, notes: [...plan.notes, nudge] };
  }

  /** Re-issue the request ONCE with the previous attempt + validation errors so the model can self-correct. */
  private async attemptRepair(
    prompt: string,
    payload: Record<string, unknown>,
    previousSteps: unknown,
    errors: string[],
    index: ReturnType<typeof buildCapabilityIndex>,
    onEvent: PlanEventHandler | undefined,
    composition: PlannerContext["composition"]
  ): Promise<AiPlan | null> {
    const repairPayload = {
      ...payload,
      repair: { previous: JSON.stringify(previousSteps).slice(0, 4000), errors: errors.slice(0, 12) }
    };
    let streamed: StreamedPlan | "unavailable" | null;
    try {
      streamed = await this.streamRequest(repairPayload, onEvent);
    } catch {
      streamed = null;
    }
    if (streamed === "unavailable" || streamed === null) {
      return null;
    }
    return this.buildPlan(prompt, streamed, index, onEvent, composition).plan;
  }

  /**
   * Local (Ollama) plan: stream the same system prompt + user content directly from the user's model,
   * emitting the same provider/reasoning/phase events as the cloud path. Returns null on an
   * unparseable reply (caller then falls back to the gateway); throws on transport failure.
   */
  private async streamLocal(
    userContent: string,
    images: string[] | undefined,
    config: { baseUrl: string; model: string },
    onEvent: PlanEventHandler | undefined
  ): Promise<StreamedPlan | null> {
    const provider = `ollama:${config.model}`;
    onEvent?.({ type: "provider", provider });
    onEvent?.({ type: "phase", index: 3 });
    const result = await streamOllamaChat(
      { baseUrl: config.baseUrl, model: config.model, system: PLANNER_SYSTEM_PROMPT, user: userContent, images },
      {
        onReasoning: (delta) => {
          onEvent?.({ type: "reasoning", delta });
          onEvent?.({ type: "phase", index: 3 });
        },
        onAnswerStart: () => onEvent?.({ type: "phase", index: 4 })
      }
    );
    const parsed = extractPlanJson(result.text);
    if (!parsed) {
      return null;
    }
    return { plan: parsed as RawPlan, provider, ...(result.reasoning ? { reasoning: result.reasoning } : {}) };
  }

  /** POST the NDJSON stream and dispatch live phase/reasoning events; resolve the final plan. */
  private async streamRequest(
    payload: Record<string, unknown>,
    onEvent: PlanEventHandler | undefined
  ): Promise<StreamedPlan | "unavailable" | null> {
    const response = await fetch(`${API_URL}/ai/plan/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok || !response.body) {
      return null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reasoning = "";
    let unavailable = false;
    let done: { plan?: RawPlan | null; provider?: string; reasoning?: string } | null = null;

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: { e?: string; provider?: string; delta?: string; plan?: RawPlan | null; reasoning?: string };
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }
        switch (event.e) {
          case "provider":
            if (event.provider) onEvent?.({ type: "provider", provider: event.provider });
            onEvent?.({ type: "phase", index: 3 });
            break;
          case "reasoning":
            if (typeof event.delta === "string") {
              reasoning += event.delta;
              onEvent?.({ type: "reasoning", delta: event.delta });
              onEvent?.({ type: "phase", index: 3 });
            }
            break;
          case "answer":
            onEvent?.({ type: "phase", index: 4 });
            break;
          case "unavailable":
            unavailable = true;
            break;
          case "done":
            done = event;
            break;
          default:
            break;
        }
      }
    }

    if (unavailable) return "unavailable";
    if (!done || !done.plan) return null;
    return { plan: done.plan, provider: done.provider, reasoning: done.reasoning ?? reasoning };
  }

  /** Validate the model's plan against the registries and assemble an `AiPlan`. `dropped` lists param-validation failures (for the repair pass). */
  private buildPlan(
    prompt: string,
    streamed: StreamedPlan,
    index: ReturnType<typeof buildCapabilityIndex>,
    onEvent: PlanEventHandler | undefined,
    composition: PlannerContext["composition"]
  ): { plan: AiPlan | null; dropped: string[] } {
    const raw = streamed.plan;
    if (!raw || !Array.isArray(raw.steps)) return { plan: null, dropped: [] };

    onEvent?.({ type: "phase", index: 5 });
    const { steps, dropped } = validateSteps(raw.steps, index, prompt, composition);
    if (steps.length === 0) return { plan: null, dropped };

    const rawConfidence = typeof raw.confidence === "number" ? raw.confidence : 0.5;
    const confidencePercent = Math.round(Math.max(0, Math.min(1, rawConfidence)) * 100);
    const confidence = labelForPercent(confidencePercent);
    const notes = Array.isArray(raw.notes)
      ? raw.notes.filter((note): note is string => typeof note === "string").slice(0, 8)
      : [];
    const totalCredits = steps.reduce((sum, step) => sum + step.cost.credits, 0);

    return {
      plan: {
        id: `plan_llm_${Date.now().toString(36)}`,
        prompt,
        steps,
        totalCredits,
        confidence,
        confidencePercent,
        notes,
        ...(streamed.reasoning && streamed.reasoning.trim() ? { reasoning: streamed.reasoning } : {}),
        ...(streamed.provider ? { provider: streamed.provider } : {})
      },
      dropped
    };
  }
}

/**
 * Keep only steps that reference capabilities Lumio actually has AND whose params
 * pass the action's Zod schema; recompute costs locally. `dropped` collects
 * param-validation failures so the planner can hand them back for one repair pass.
 */
function validateSteps(
  raw: unknown[],
  index: ReturnType<typeof buildCapabilityIndex>,
  prompt: string,
  composition: PlannerContext["composition"]
): { steps: PlanStep[]; dropped: string[] } {
  const steps: PlanStep[] = [];
  const dropped: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const summary = typeof candidate.summary === "string" ? candidate.summary : "";

    if (candidate.kind === "timelineAction" && typeof candidate.actionId === "string" && index.hasAction(candidate.actionId)) {
      const params = backfillParams(candidate.actionId, candidate.params, prompt, composition);
      const validation = index.validateActionParams(candidate.actionId, params);
      if (!validation.ok) {
        dropped.push(`${candidate.actionId}: ${validation.errors.join("; ")}`);
        continue;
      }
      const effectType = (params as { effectType?: unknown } | undefined)?.effectType;
      if (typeof effectType === "string") {
        recordEffectDemand(effectType);
      }
      steps.push({
        id: stepId(),
        kind: "timelineAction",
        actionId: candidate.actionId,
        params,
        summary: summary || `Run ${candidate.actionId}`,
        cost: actionCost()
      });
      continue;
    }

    if (candidate.kind === "timelineAction" && typeof candidate.actionId === "string") {
      dropped.push(`${candidate.actionId}: unknown action`);
      continue;
    }

    if (candidate.kind === "tool" && typeof candidate.toolSlug === "string") {
      const tool = index.findTool(candidate.toolSlug);
      if (tool) {
        recordToolDemand(tool.slug);
        steps.push({
          id: stepId(),
          kind: "tool",
          toolSlug: tool.slug,
          summary: summary || tool.name,
          ...(candidate.requiresInput === true ? { requiresInput: true } : {}),
          cost: classifyToolCost(tool.slug)
        });
      }
      continue;
    }

    if (candidate.kind === "clarify" && typeof candidate.question === "string") {
      steps.push({
        id: stepId(),
        kind: "clarify",
        question: candidate.question,
        summary: summary || "Ask for clarification",
        cost: actionCost()
      });
    }
  }
  return { steps, dropped };
}

/**
 * Backfill obvious entities the model dropped. Free models often pick the right
 * action (e.g. `addShape`) but forget an optional param the user clearly asked for
 * (e.g. the `color`), so the shape renders with the default fill. We only ADD a
 * missing param when the prompt unambiguously contains it — never overriding a value
 * the model did set.
 */
function backfillParams(
  actionId: string,
  rawParams: unknown,
  prompt: string,
  composition: PlannerContext["composition"]
): unknown {
  if (actionId !== "addShape" && actionId !== "addText" && actionId !== "updateText") {
    return rawParams;
  }
  const params: Record<string, unknown> = rawParams && typeof rawParams === "object" ? { ...(rawParams as object) } : {};
  if (params.color === undefined) {
    const color = extractColor(prompt);
    if (color) params.color = color;
  }
  if (actionId === "addText" || actionId === "updateText") {
    if (params.size === undefined) {
      const size = extractSize(prompt);
      if (size) params.size = size;
    }
    const style = extractTextStyle(prompt);
    if (params.bold === undefined && style.bold !== undefined) params.bold = style.bold;
    if (params.italic === undefined && style.italic !== undefined) params.italic = style.italic;
  }
  // Shape kind/size/orientation: the model picks `addShape` but is unreliable at
  // aspect-correct geometry (a "circle" comes back a wide blob or a "pill"). The
  // shape KIND in the prompt is unambiguous, so when our resolver recognises one we
  // make its geometry authoritative — override the model's width/height/radius
  // (not color/position) so a circle is always a circle.
  if (actionId === "addShape") {
    const geometry = resolveShapeGeometry(prompt, composition);
    if (geometry.isShape) {
      if (geometry.widthPercent !== undefined) params.widthPercent = geometry.widthPercent;
      if (geometry.heightPercent !== undefined) params.heightPercent = geometry.heightPercent;
      if (geometry.borderRadius !== undefined) params.borderRadius = geometry.borderRadius;
    }
  }
  return params;
}

/** Max layers to include in the slice — keeps the payload (and cost) bounded. */
const SLICE_LAYER_CAP = 12;

/**
 * COST RULE: never send the whole project to the LLM. We send only a relevant
 * *slice* — the selected layers plus the layers active at the playhead — trimmed
 * to the few fields the planner needs to target an edit (id/type/name/timing +
 * light style hints). Keyframes, animations, transform matrices, matte/cutout
 * blobs, asset binaries, and off-screen layers are all omitted. This is the
 * 80–95% payload reduction vs. serialising the full `TimelineComposition`.
 */
function summarizeContext(ctx: PlannerContext): string {
  const allLayers = ctx.composition.tracks.flatMap((track) => track.layers);
  const byType = allLayers.reduce<Record<string, number>>((acc, layer) => {
    acc[layer.type] = (acc[layer.type] ?? 0) + 1;
    return acc;
  }, {});
  const counts = Object.entries(byType)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");

  const slice = relevantLayers(ctx).slice(0, SLICE_LAYER_CAP).map((layer) => trimLayer(layer));

  // P10 — tell the model whether this message continues the previous request or
  // starts a new one, so it doesn't assume an edit targets a prior layer.
  const intentHint =
    ctx.intentScope === "continue" && ctx.lastAction
      ? `Intent: this CONTINUES the previous request — it likely edits the last-touched layer(s): ${ctx.lastAction.targetLayerIds.join(", ")}.`
      : ctx.intentScope === "new"
        ? "Intent: this is a NEW request — do NOT assume it edits a previously created layer; create new layers as needed."
        : "";

  const header = [
    `Playhead at ${ctx.nowSeconds.toFixed(2)}s.`,
    allLayers.length ? `Project totals: ${counts} (${allLayers.length} layers).` : "Empty timeline.",
    ctx.selection.length ? `Selected: ${ctx.selection.length} layer(s).` : "Nothing selected.",
    intentHint,
    // P11 — learned preferences (a steer to fill defaults; never a hard rule).
    ctx.memoryNote ? `Memory: ${ctx.memoryNote}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  // The slice carries real layer ids the planner may target directly.
  return `${header}\nRELEVANT LAYERS (slice only — not the whole project):\n${JSON.stringify(slice)}`;
}

/** Selected layers first, then layers playing at the playhead; de-duplicated, order-stable. */
function relevantLayers(ctx: PlannerContext) {
  const all = ctx.composition.tracks.flatMap((track) => track.layers);
  const selected = new Set(ctx.selection);
  const now = ctx.nowSeconds;
  const isActive = (layer: { startSeconds: number; durationSeconds: number }) =>
    now >= layer.startSeconds && now <= layer.startSeconds + layer.durationSeconds;

  const picked = all.filter((layer) => selected.has(layer.id) || isActive(layer));
  // If nothing is selected and the playhead is over empty space, fall back to the first few.
  return picked.length > 0 ? picked : all.slice(0, SLICE_LAYER_CAP);
}

/** Keep only planner-relevant fields; drop heavy/irrelevant data and trim text. */
function trimLayer(layer: {
  id: string;
  type: string;
  name: string;
  startSeconds: number;
  durationSeconds: number;
  text?: string | undefined;
  fontSize?: number | undefined;
  color?: string | undefined;
  effects?: { id: string; type: string }[];
}) {
  return {
    id: layer.id,
    type: layer.type,
    name: layer.name.slice(0, 40),
    start: Number(layer.startSeconds.toFixed(2)),
    duration: Number(layer.durationSeconds.toFixed(2)),
    ...(typeof layer.text === "string" ? { text: layer.text.slice(0, 60) } : {}),
    ...(typeof layer.fontSize === "number" ? { fontSize: layer.fontSize } : {}),
    ...(typeof layer.color === "string" ? { color: layer.color } : {}),
    // Effects carry their real id + type so the planner can target removeEffect/
    // updateEffect directly — never ask the user for an internal id.
    ...(layer.effects && layer.effects.length
      ? { effects: layer.effects.map((effect) => ({ id: effect.id, type: effect.type })) }
      : {})
  };
}
