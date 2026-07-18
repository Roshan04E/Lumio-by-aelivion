import { Router, type Request } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  PLANNER_SYSTEM_PROMPT,
  ACK_SYSTEM_PROMPT,
  CONSULTANT_SYSTEM_PROMPT,
  FAST_PLANNER_SYSTEM_PROMPT,
  buildPlannerUserContent,
  buildConsultantUserContent,
  buildFastPlannerUserContent,
  extractPlanJson
} from "@orreris/shared";
import { env } from "../config/env";
import { asyncHandler, ok, validateBody } from "../lib/http";
import { aiLog, promptHash, snippet } from "../lib/logger";
import {
  gatewayHasProvider,
  gatewayHasVisionProvider,
  planWithGateway,
  streamPlanWithGateway
} from "../services/aiGateway.service";
import { recordUsage } from "../services/usageLedger.service";

/**
 * These routes are intentionally NOT behind `requireAuth` (guests can use the planner). For
 * Phase 0 shadow-billing we still want to attribute usage to a signed-in user when possible,
 * without making auth required or changing any route's behavior — so this only decodes a
 * bearer token if present and never throws/blocks on a missing or invalid one.
 */
function optionalUserId(req: Request): string | undefined {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) return undefined;
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
    return payload.sub;
  } catch {
    return undefined;
  }
}

/**
 * Orreris AI — planner gateway route (GP1). The browser's `LlmPlanner` POSTs here;
 * this turns a prompt + the live capability description + a relevant project slice
 * into an ordered plan of REGISTERED tools/actions, via the multi-provider failover
 * gateway. It never mutates anything — the web side validates every step against the
 * Timeline Action Registry before executing, and falls back to the deterministic
 * planner when the pool is exhausted.
 *
 * No provider key configured → `{ available: false }` (200), so the client falls back.
 * AI is an operator, not a magic box: the model only *selects* among capabilities
 * Orreris already exposes, and returns a numeric confidence the UI surfaces directly.
 */
export const aiRouter = Router();

// Up to 2 reference images, each a data URL capped ~1.4MB of base64 (≈1MB image).
const imageArraySchema = z.array(z.string().startsWith("data:image/").max(1_400_000)).max(2).optional();

const planRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  /** `capabilityIndex.describeForPlanner()` — the tools/effects/actions the planner may use. */
  capabilities: z.string().min(1).max(20000),
  /** A bounded RELEVANT SLICE of the project (selected + active layers, trimmed) — never the whole timeline. */
  context: z.string().max(8000).optional(),
  /** Prior conversation turns for follow-up awareness. */
  history: z
    .array(z.object({ role: z.enum(["user", "ai"]), text: z.string().max(2000) }))
    .max(20)
    .optional(),
  /** GP3 — the user's own provider key, used only for this request (never stored/logged). */
  byo: z
    .object({
      provider: z.enum(["cerebras", "groq", "openrouter", "gemini", "anthropic"]),
      apiKey: z.string().min(8).max(400),
      model: z.string().max(120).optional()
    })
    .optional(),
  /** GP4 — "Best Quality" mode: opt into the shared paid Claude hop (used only if a server key is set). */
  premium: z.boolean().optional(),
  /** Reference images as data URLs (downscaled client-side). Routed to a vision-capable provider. */
  images: imageArraySchema,
  /** One bounded agentic repair: the previous (invalid) plan + the client-side validation errors to fix. */
  repair: z
    .object({
      previous: z.string().max(6000),
      errors: z.array(z.string().max(400)).max(12)
    })
    .optional(),
  /** Hands-free voice session — replies get the spoken-conversation register (VOICE_MODE_NOTE). */
  voiceMode: z.boolean().optional()
});

// --- Lightweight per-IP rate limit + short-TTL plan cache (protects small free quotas) ---
const RATE_MAX = 12;
const RATE_WINDOW_MS = 60_000;
const CACHE_TTL_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const planCache = new Map<string, { value: unknown; expires: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX;
}

function cacheKey(parts: string): string {
  let hash = 5381;
  for (let i = 0; i < parts.length; i += 1) {
    hash = ((hash << 5) + hash + parts.charCodeAt(i)) | 0;
  }
  return `k${hash}_${parts.length}`;
}

aiRouter.post(
  "/plan",
  asyncHandler(async (req, res) => {
    const body = validateBody(planRequestSchema, req.body);
    if (!gatewayHasProvider() && !body.byo) {
      return ok(res, "No LLM provider configured", { available: false });
    }
    const gatewayOptions = { byo: body.byo, premium: body.premium, ...(body.images ? { images: body.images } : {}) };
    if (body.images?.length && !gatewayHasVisionProvider(gatewayOptions)) {
      return ok(res, "No vision-capable provider", { available: true, plan: null, visionUnavailable: true });
    }

    // BYO requests run on the user's own quota → exempt from our shared per-IP limit.
    if (!body.byo) {
      const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.ip ?? "unknown").trim();
      if (rateLimited(ip)) {
        aiLog.debug(`plan ${promptHash(body.prompt)}: rate limited`);
        return ok(res, "Rate limited", { available: true, plan: null, rateLimited: true });
      }
    }

    // Don't cache image-bearing requests (the reference varies per call).
    const key = cacheKey(
      `${body.byo?.provider ?? "pool"}|${body.premium ? "best" : "free"}|${body.voiceMode ? "voice" : "typed"}|${body.prompt}|${body.context ?? ""}|${body.capabilities.length}|${body.repair ? "repair" : "fresh"}`
    );
    const cached = !body.images?.length ? planCache.get(key) : undefined;
    if (cached && cached.expires > Date.now()) {
      return ok(res, "LLM plan (cached)", { available: true, plan: cached.value, cached: true });
    }

    const hash = promptHash(body.prompt);
    const result = await planWithGateway(PLANNER_SYSTEM_PROMPT, buildPlannerUserContent(body), gatewayOptions);
    if (!result) {
      aiLog.warn(`plan ${hash}: pool exhausted, no plan returned`);
      return ok(res, "LLM pool exhausted", { available: true, plan: null });
    }
    const usageUserId = optionalUserId(req);
    if (usageUserId) {
      void recordUsage({ userId: usageUserId, action: "assistant.plan", units: 1, provider: result.providerId });
    }

    const parsed = extractPlanJson(result.text);
    if (!parsed) {
      aiLog.warn(`plan ${hash}: ${result.providerId} returned unparseable reply: ${snippet(result.text)}`);
      return ok(res, "LLM returned no usable plan", { available: true, plan: null, provider: result.providerId });
    }

    const payload = {
      available: true,
      plan: parsed,
      provider: result.providerId,
      ...(result.reasoning ? { reasoning: result.reasoning } : {})
    };
    // Cache the plan only (reasoning is per-run); never cache image-bearing requests.
    if (!body.images?.length) {
      planCache.set(key, { value: parsed, expires: Date.now() + CACHE_TTL_MS });
    }
    return ok(res, "LLM plan", payload);
  })
);

// --- Orreris Brain B4 — tier-3 transactional compiler (`fast` model class) -----

const fastPlanRequestSchema = z.object({
  prompt: z.string().min(1).max(300),
  /** Compact action catalog (ids + param hints) built client-side from the live registry. */
  actions: z.string().min(1).max(8000),
  /** Target-clip-only slice. */
  context: z.string().max(2500).optional()
});

const fastPlanReplySchema = z.object({
  escalate: z.boolean().optional(),
  steps: z
    .array(
      z.object({
        actionId: z.string().min(1).max(60),
        params: z.unknown().optional(),
        summary: z.string().max(200).optional()
      })
    )
    .max(6)
    .optional()
});

/**
 * One non-reasoning call, JSON steps or escalate. The client re-validates every step against
 * the Timeline Action Registry's Zod schemas before anything runs — this endpoint only routes.
 */
aiRouter.post(
  "/plan/fast",
  asyncHandler(async (req, res) => {
    const body = validateBody(fastPlanRequestSchema, req.body);
    if (!gatewayHasProvider()) {
      return ok(res, "No LLM provider configured", { available: false });
    }
    const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.ip ?? "unknown").trim();
    if (rateLimited(ip)) {
      aiLog.debug(`fast ${promptHash(body.prompt)}: rate limited`);
      return ok(res, "Rate limited", { available: true, escalate: true, rateLimited: true });
    }

    const key = cacheKey(`fast|${body.prompt}|${body.context ?? ""}|${body.actions.length}`);
    const cached = planCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return ok(res, "Fast plan (cached)", { available: true, ...(cached.value as object), cached: true });
    }

    const hash = promptHash(body.prompt);
    const result = await planWithGateway(FAST_PLANNER_SYSTEM_PROMPT, buildFastPlannerUserContent(body), {
      modelClass: "fast"
    });
    if (!result) {
      aiLog.debug(`fast ${hash}: fast pool exhausted`);
      return ok(res, "Fast pool exhausted", { available: true, escalate: true });
    }
    const usageUserId = optionalUserId(req);
    if (usageUserId) {
      void recordUsage({ userId: usageUserId, action: "assistant.plan.fast", units: 1, provider: result.providerId });
    }

    const parsed = fastPlanReplySchema.safeParse(extractPlanJson(result.text));
    if (!parsed.success || parsed.data.escalate || !parsed.data.steps?.length) {
      if (!parsed.success) {
        aiLog.debug(`fast ${hash}: ${result.providerId} unparseable reply: ${snippet(result.text)}`);
      }
      const payload = { escalate: true as const, provider: result.providerId };
      planCache.set(key, { value: payload, expires: Date.now() + CACHE_TTL_MS });
      return ok(res, "Fast plan escalated", { available: true, ...payload });
    }

    const payload = { steps: parsed.data.steps, provider: result.providerId };
    planCache.set(key, { value: payload, expires: Date.now() + CACHE_TTL_MS });
    return ok(res, "Fast plan", { available: true, ...payload });
  })
);

const ackRequestSchema = z.object({ prompt: z.string().min(1).max(500) });

/**
 * Voice progressive-response ack: ONE prompt-specific spoken line from the fast pool while the
 * real planner thinks. Payload-free by contract (no context/capabilities/history) — its whole
 * value is landing in well under a second. Not counted against the per-IP planner budget (it
 * always accompanies a /plan call that IS counted); cached per prompt like everything else.
 */
aiRouter.post(
  "/ack",
  asyncHandler(async (req, res) => {
    const body = validateBody(ackRequestSchema, req.body);
    if (!gatewayHasProvider()) {
      return ok(res, "No LLM provider configured", { available: false, text: null });
    }
    const key = cacheKey(`ack|${body.prompt}`);
    const cached = planCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return ok(res, "Ack (cached)", { available: true, text: cached.value, cached: true });
    }
    const result = await planWithGateway(ACK_SYSTEM_PROMPT, `REQUEST:\n${body.prompt}`, { modelClass: "fast" });
    if (!result) {
      return ok(res, "Fast pool exhausted", { available: true, text: null });
    }
    const usageUserId = optionalUserId(req);
    if (usageUserId) {
      void recordUsage({ userId: usageUserId, action: "assistant.ack", units: 1, provider: result.providerId });
    }
    // One line, unquoted, spoken-length — defend against chatty fast models.
    const text = result.text.trim().split("\n")[0]!.replace(/^["'“]+|["'”]+$/g, "").slice(0, 140).trim() || null;
    planCache.set(key, { value: text, expires: Date.now() + CACHE_TTL_MS });
    return ok(res, "Ack", { available: true, text, provider: result.providerId });
  })
);

/**
 * GP2.1 — streaming planner. Same pool/rate-limit/cache as `/plan`, but relays the
 * chosen provider's reasoning + answer deltas live as newline-delimited JSON (NDJSON),
 * so the browser can render the "thinking" in real time. Events:
 *   {"e":"provider","provider":...} · {"e":"reasoning","delta":...} · {"e":"answer"}
 *   {"e":"done","plan":{...}|null,"provider":...,"reasoning":...} · {"e":"unavailable"}
 */
aiRouter.post(
  "/plan/stream",
  asyncHandler(async (req, res) => {
    const body = validateBody(planRequestSchema, req.body); // throws 400 before any streaming headers

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.flushHeaders?.();
    const send = (event: Record<string, unknown>) => res.write(`${JSON.stringify(event)}\n`);

    if (!gatewayHasProvider() && !body.byo) {
      send({ e: "unavailable" });
      return res.end();
    }
    const gatewayOptions = { byo: body.byo, premium: body.premium, ...(body.images ? { images: body.images } : {}) };
    if (body.images?.length && !gatewayHasVisionProvider(gatewayOptions)) {
      send({ e: "unavailable", reason: "vision" });
      return res.end();
    }

    if (!body.byo) {
      const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.ip ?? "unknown").trim();
      if (rateLimited(ip)) {
        aiLog.debug(`stream ${promptHash(body.prompt)}: rate limited`);
        send({ e: "unavailable" });
        return res.end();
      }
    }

    const key = cacheKey(
      `${body.byo?.provider ?? "pool"}|${body.premium ? "best" : "free"}|${body.voiceMode ? "voice" : "typed"}|${body.prompt}|${body.context ?? ""}|${body.capabilities.length}|${body.repair ? "repair" : "fresh"}`
    );
    // Image-bearing requests vary by reference — never serve/store them from cache.
    const cached = !body.images?.length ? planCache.get(key) : undefined;
    if (cached && cached.expires > Date.now()) {
      send({ e: "done", plan: cached.value, cached: true });
      return res.end();
    }

    const userContent = buildPlannerUserContent(body);

    try {
      const result = await streamPlanWithGateway(
        PLANNER_SYSTEM_PROMPT,
        userContent,
        {
          onProvider: (provider) => send({ e: "provider", provider }),
          onReasoning: (delta) => send({ e: "reasoning", delta }),
          onAnswerStart: () => send({ e: "answer" })
        },
        gatewayOptions
      );

      if (!result) {
        aiLog.warn(`stream ${promptHash(body.prompt)}: pool exhausted, no plan returned`);
        send({ e: "done", plan: null });
        return res.end();
      }
      const usageUserId = optionalUserId(req);
      if (usageUserId) {
        void recordUsage({ userId: usageUserId, action: "assistant.plan.stream", units: 1, provider: result.providerId });
      }
      const parsed = extractPlanJson(result.text);
      if (parsed && !body.images?.length) {
        planCache.set(key, { value: parsed, expires: Date.now() + CACHE_TTL_MS });
      } else if (!parsed) {
        aiLog.warn(`stream ${promptHash(body.prompt)}: ${result.providerId} returned unparseable reply: ${snippet(result.text)}`);
      }
      send({ e: "done", plan: parsed ?? null, provider: result.providerId, ...(result.reasoning ? { reasoning: result.reasoning } : {}) });
      return res.end();
    } catch (error) {
      // Headers already sent — finish gracefully so the client falls back.
      aiLog.warn(`stream ${promptHash(body.prompt)}: error after headers: ${error instanceof Error ? error.message : String(error)}`);
      send({ e: "done", plan: null });
      return res.end();
    }
  })
);

// --- Talk mode: a conversational "creative consultant" that never mutates -----

const chatRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  context: z.string().max(8000).optional(),
  memoryNote: z.string().max(1000).optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "ai"]), text: z.string().max(2000) }))
    .max(20)
    .optional(),
  byo: z
    .object({
      provider: z.enum(["cerebras", "groq", "openrouter", "gemini", "anthropic"]),
      apiKey: z.string().min(8).max(400),
      model: z.string().max(120).optional()
    })
    .optional(),
  premium: z.boolean().optional(),
  images: imageArraySchema,
  /** Hands-free voice session — replies get the spoken-conversation register (VOICE_MODE_NOTE). */
  voiceMode: z.boolean().optional()
});

/**
 * Talk mode — streams a conversational reply (no plan, no registry validation). Events:
 *   {"e":"provider"} · {"e":"reasoning","delta"} · {"e":"message","delta"} · {"e":"done"} · {"e":"unavailable"}
 */
aiRouter.post(
  "/chat/stream",
  asyncHandler(async (req, res) => {
    const body = validateBody(chatRequestSchema, req.body);

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.flushHeaders?.();
    const send = (event: Record<string, unknown>) => res.write(`${JSON.stringify(event)}\n`);

    if (!gatewayHasProvider() && !body.byo) {
      send({ e: "unavailable" });
      return res.end();
    }
    const gatewayOptions = { byo: body.byo, premium: body.premium, ...(body.images ? { images: body.images } : {}) };
    if (body.images?.length && !gatewayHasVisionProvider(gatewayOptions)) {
      send({ e: "unavailable", reason: "vision" });
      return res.end();
    }

    if (!body.byo) {
      const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.ip ?? "unknown").trim();
      if (rateLimited(ip)) {
        send({ e: "unavailable" });
        return res.end();
      }
    }

    try {
      const result = await streamPlanWithGateway(
        CONSULTANT_SYSTEM_PROMPT,
        buildConsultantUserContent(body),
        {
          onProvider: (provider) => send({ e: "provider", provider }),
          onReasoning: (delta) => send({ e: "reasoning", delta }),
          onContent: (delta) => send({ e: "message", delta })
        },
        gatewayOptions
      );
      if (!result) {
        aiLog.warn(`chat ${promptHash(body.prompt)}: pool exhausted`);
        // Honest signal — the client shows "couldn't reach a model", not an empty reply.
        send({ e: "unavailable", reason: "exhausted" });
        return res.end();
      }
      const usageUserId = optionalUserId(req);
      if (usageUserId) {
        void recordUsage({ userId: usageUserId, action: "assistant.chat.stream", units: 1, provider: result.providerId });
      }
      send({ e: "done", provider: result.providerId });
      return res.end();
    } catch (error) {
      aiLog.warn(`chat ${promptHash(body.prompt)}: error after headers: ${error instanceof Error ? error.message : String(error)}`);
      send({ e: "done", provider: null });
      return res.end();
    }
  })
);
