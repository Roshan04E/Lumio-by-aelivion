import { env } from "../config/env";
import { aiLog, snippet } from "../lib/logger";

/**
 * Lumio AI — multi-provider planner gateway (GP1).
 *
 * One OpenAI-compatible client over a prioritized pool of free reasoning models,
 * with automatic failover: on 429/503/5xx/timeout a provider is put in a short
 * cooldown and the next one is tried. A provider is only in the pool when its API
 * key is present. The route falls back to the deterministic planner when the whole
 * pool is exhausted, so the editor never breaks.
 *
 * All members expose `POST {baseUrl}/chat/completions`. Model IDs are
 * env-overridable because free tiers drift constantly.
 */

interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Whether this provider's model accepts image inputs (reference-image feature). */
  supportsVision?: boolean;
}

export interface GatewayResult {
  providerId: string;
  /** Model reply text with any `<think>…</think>` reasoning block stripped. */
  text: string;
  /** The model's chain-of-thought (GP2 "thinking" log), capped — undefined if the model exposes none. */
  reasoning?: string;
}

/** Cap the reasoning trace so the payload stays small. */
const REASONING_CAP = 3000;

/** GP3 — a user's own key, used only for their request (never stored/logged server-side). */
export interface ByoOverride {
  provider: string;
  apiKey: string;
  model?: string | undefined;
}

const BYO_BASE_URL: Record<string, string> = {
  cerebras: "https://api.cerebras.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  // Anthropic's OpenAI-compatible endpoint — same /chat/completions shape, Claude models.
  anthropic: "https://api.anthropic.com/v1"
};

function byoDefaultModel(provider: string): string {
  switch (provider) {
    case "cerebras":
      return env.CEREBRAS_MODEL;
    case "groq":
      return env.GROQ_MODEL;
    case "openrouter":
      return env.OPENROUTER_MODEL;
    case "gemini":
      return env.GEMINI_PLANNER_MODEL;
    case "anthropic":
      return env.ANTHROPIC_PLANNER_MODEL;
    default:
      return "";
  }
}

/** Build a single-provider config from a user's own key (tried first), or null if unusable. */
function byoConfig(byo: ByoOverride | undefined): ProviderConfig | null {
  if (!byo?.apiKey) return null;
  const baseUrl = BYO_BASE_URL[byo.provider];
  const model = byo.model || byoDefaultModel(byo.provider);
  if (!baseUrl || !model) return null;
  // Distinct id so the user's key has its own cooldown, separate from the shared pool.
  // Assume BYO can do vision — the user picked the model and knows its capabilities.
  return { id: `byo-${byo.provider}`, baseUrl, apiKey: byo.apiKey, model, supportsVision: true };
}

/**
 * GP4 — the shared, paid Claude hop (your `ANTHROPIC_API_KEY`), gated to "Best
 * Quality" mode only. Returns null when no key is set, so 95% of (free-mode)
 * traffic never touches it. When premium is requested it's tried FIRST (best model
 * for the hardest requests), with the free pool as failover.
 */
function premiumClaudeConfig(): ProviderConfig | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return {
    id: "claude-premium",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_PLANNER_MODEL,
    supportsVision: true
  };
}

/** Priority order: fastest free reasoning models first. */
function pool(): ProviderConfig[] {
  return [
    { id: "cerebras", baseUrl: "https://api.cerebras.ai/v1", apiKey: env.CEREBRAS_API_KEY, model: env.CEREBRAS_MODEL },
    { id: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL },
    { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL },
    {
      id: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_PLANNER_MODEL,
      // Gemini flash models are natively multimodal — the only vision-capable
      // member of the free pool (the llama text models are not).
      supportsVision: true
    }
  ];
}

/** Provider id → epoch ms until which it is "cooling down" after a failure. */
const cooldownUntil = new Map<string, number>();
const COOLDOWN_BUSY_MS = 60_000; // 429 / 503 / 5xx / timeout
const COOLDOWN_AUTH_MS = 10 * 60_000; // 401 / 403 / bad model → key/config problem
const REQUEST_TIMEOUT_MS = 22_000; // reasoning models are slow

export function gatewayHasProvider(): boolean {
  return pool().some((provider) => Boolean(provider.apiKey));
}

/** Whether any usable provider can accept the attached image(s) (for a clear "needs vision" message). */
export function gatewayHasVisionProvider(options: GatewayOptions = {}): boolean {
  return candidatesFor({ ...options, images: ["x"] }).length > 0;
}

/**
 * Build the OpenAI-compatible user `content`: a plain string normally, or a
 * multimodal array (text + `image_url` parts) when reference images are attached.
 */
function buildUserMessage(user: string, images: string[] | undefined): unknown {
  if (!images || images.length === 0) {
    return user;
  }
  return [
    { type: "text", text: user },
    ...images.map((url) => ({ type: "image_url", image_url: { url } }))
  ];
}

export interface GatewayOptions {
  /** GP3 — the user's own key (tried first). */
  byo?: ByoOverride | undefined;
  /** GP4 — "Best Quality": include the shared paid Claude hop (first, when configured). */
  premium?: boolean | undefined;
  /** Reference images (data URLs) to attach to the user turn. */
  images?: string[] | undefined;
}

/** True when the caller attached at least one image (routes to a vision-capable provider). */
function needsVision(options: GatewayOptions): boolean {
  return Array.isArray(options.images) && options.images.length > 0;
}

/** Build the ordered candidate list: BYO key → premium Claude → free pool (each gated). */
function candidatesFor(options: GatewayOptions): ProviderConfig[] {
  const now = Date.now();
  const ordered = [byoConfig(options.byo), options.premium ? premiumClaudeConfig() : null, ...pool()];
  const visionFiltered = needsVision(options) ? ordered.filter((provider) => provider?.supportsVision) : ordered;
  const candidates = visionFiltered.filter(
    (provider): provider is ProviderConfig =>
      Boolean(provider?.apiKey) && (cooldownUntil.get(provider!.id) ?? 0) <= now
  );
  const cooling = ordered
    .filter((provider): provider is ProviderConfig => Boolean(provider?.apiKey) && (cooldownUntil.get(provider!.id) ?? 0) > now)
    .map((provider) => provider.id);
  aiLog.debug(
    `candidates: [${candidates.map((provider) => provider.id).join(", ") || "none"}]`,
    cooling.length ? `(cooling down: ${cooling.join(", ")})` : ""
  );
  return candidates;
}

/** Run the prompt through the pool (BYO/premium first when supplied), returning the first reply or null. */
export async function planWithGateway(
  system: string,
  user: string,
  options: GatewayOptions = {}
): Promise<GatewayResult | null> {
  const candidates = candidatesFor(options);

  for (const provider of candidates) {
    try {
      aiLog.debug(`try ${provider.id} (${provider.model})`);
      const result = await callProvider(provider, system, user, options.images);
      if (result.text && result.text.trim()) {
        aiLog.debug(`ok ${provider.id} (${result.text.length} chars)`);
        return { providerId: provider.id, text: result.text, ...(result.reasoning ? { reasoning: result.reasoning } : {}) };
      }
      // Empty completion — treat as a soft miss, brief cooldown, try next.
      aiLog.debug(`${provider.id} empty completion — cooldown ${COOLDOWN_BUSY_MS}ms`);
      cooldownUntil.set(provider.id, Date.now() + COOLDOWN_BUSY_MS);
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : 0;
      const cool = status === 401 || status === 403 || status === 404 ? COOLDOWN_AUTH_MS : COOLDOWN_BUSY_MS;
      aiLog.debug(`${provider.id} failed: ${error instanceof Error ? error.message : String(error)} — cooldown ${cool}ms`);
      cooldownUntil.set(provider.id, Date.now() + cool);
    }
  }
  aiLog.warn(`pool exhausted — ${candidates.length} provider(s) tried, no plan`);
  return null;
}

class ProviderError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function callProvider(
  provider: ProviderConfig,
  system: string,
  user: string,
  images?: string[]
): Promise<{ text: string; reasoning?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
        // OpenRouter attribution headers (ignored by the others).
        "HTTP-Referer": env.WEB_ORIGIN,
        "X-Title": "Lumio AI"
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 4096,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: buildUserMessage(user, images) }
        ]
      })
    });

    if (!response.ok) {
      throw new ProviderError(response.status, `${provider.id} HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string; reasoning?: string; reasoning_content?: string } }[];
    };
    const message = json.choices?.[0]?.message ?? {};
    const content = message.content ?? "";

    // Reasoning can arrive in a dedicated field (OpenRouter/DeepSeek `reasoning`,
    // some providers `reasoning_content`) and/or inline as a <think>…</think> block.
    const inlineThink = content.match(/<think>([\s\S]*?)<\/think>/i)?.[1] ?? "";
    const reasoning = [message.reasoning, message.reasoning_content, inlineThink]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n")
      .trim()
      .slice(0, REASONING_CAP);

    const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return reasoning ? { text, reasoning } : { text };
  } finally {
    clearTimeout(timer);
  }
}

export interface StreamHandlers {
  /** Fired once when a provider commits to streaming (after a 200). */
  onProvider?: (providerId: string) => void;
  /** Fired for each reasoning-token delta (live "thinking"). */
  onReasoning?: (delta: string) => void;
  /** Fired once when the first answer (non-reasoning) token arrives. */
  onAnswerStart?: () => void;
  /** Fired for each answer-token delta (Talk mode streams the prose live). */
  onContent?: (delta: string) => void;
}

/**
 * GP2.1 — streaming variant. Same failover pool, but the chosen provider is asked
 * to `stream: true` and its SSE deltas are surfaced live via `handlers`. Failover
 * only happens BEFORE the first byte (a non-200 / connect error / timeout); once a
 * provider starts streaming we commit to it. Returns the assembled result, or null
 * if the whole pool failed pre-stream.
 */
export async function streamPlanWithGateway(
  system: string,
  user: string,
  handlers: StreamHandlers,
  options: GatewayOptions = {}
): Promise<GatewayResult | null> {
  const candidates = candidatesFor(options);

  for (const provider of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      aiLog.debug(`stream try ${provider.id} (${provider.model})`);
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
          "HTTP-Referer": env.WEB_ORIGIN,
          "X-Title": "Lumio AI"
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 4096,
          temperature: 0.2,
          stream: true,
          messages: [
            { role: "system", content: system },
            { role: "user", content: buildUserMessage(user, options.images) }
          ]
        })
      });

      if (!response.ok || !response.body) {
        const cool =
          response.status === 401 || response.status === 403 || response.status === 404 ? COOLDOWN_AUTH_MS : COOLDOWN_BUSY_MS;
        aiLog.debug(`stream ${provider.id} HTTP ${response.status} — cooldown ${cool}ms`);
        cooldownUntil.set(provider.id, Date.now() + cool);
        continue;
      }

      // Committed to this provider — consume its SSE stream.
      handlers.onProvider?.(provider.id);
      const assembled = await consumeSse(response.body, handlers);
      aiLog.debug(`stream ${provider.id} done (${assembled.text.length} chars)`);
      return {
        providerId: provider.id,
        text: assembled.text,
        ...(assembled.reasoning ? { reasoning: assembled.reasoning } : {})
      };
    } catch (error) {
      aiLog.debug(`stream ${provider.id} error: ${error instanceof Error ? error.message : String(error)} — cooldown ${COOLDOWN_BUSY_MS}ms`);
      cooldownUntil.set(provider.id, Date.now() + COOLDOWN_BUSY_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  aiLog.warn(`stream pool exhausted — ${candidates.length} provider(s) tried, no plan`);
  return null;
}

/** Parse an OpenAI-compatible SSE body, streaming deltas to handlers, returning the assembled answer. */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers
): Promise<{ text: string; reasoning?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let answerStarted = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string; reasoning?: string; reasoning_content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta ?? {};
        const reasonPart = delta.reasoning ?? delta.reasoning_content;
        if (typeof reasonPart === "string" && reasonPart) {
          reasoning += reasonPart;
          handlers.onReasoning?.(reasonPart);
        }
        if (typeof delta.content === "string" && delta.content) {
          if (!answerStarted) {
            answerStarted = true;
            handlers.onAnswerStart?.();
          }
          content += delta.content;
          handlers.onContent?.(delta.content);
        }
      } catch {
        /* ignore malformed keep-alive lines */
        aiLog.debug(`malformed SSE line: ${snippet(data, 120)}`);
      }
    }
  }

  // Some models stream their thinking inline as <think>…</think> in content.
  const inlineThink = content.match(/<think>([\s\S]*?)<\/think>/i)?.[1] ?? "";
  const fullReasoning = [reasoning, inlineThink].filter((part) => part.trim()).join("\n").trim().slice(0, REASONING_CAP);
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return fullReasoning ? { text, reasoning: fullReasoning } : { text };
}
