import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.resolve(apiRoot, "../..");

dotenv.config({ path: path.join(workspaceRoot, ".env") });
dotenv.config({ path: path.join(workspaceRoot, ".env.local"), override: true });
dotenv.config({ path: path.join(apiRoot, ".env") });
dotenv.config({ path: path.join(apiRoot, ".env.local"), override: true });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4100),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4100"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://lumio:lumio@localhost:5432/lumio?schema=public"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(16).default("local-dev-secret-change-me"),
  STORAGE_ROOT: z.string().default("apps/api/storage"),
  // Google Sign-In. Optional: the web Google button only renders when its client id is set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_TRANSCRIPTION_MODEL: z.string().default("gemini-2.5-flash"),
  // Stock media provider (optional). Search shows an unconfigured/empty state when absent;
  // imports always download the file into our own storage. Provider identity is never shown in the UI.
  PEXELS_API_KEY: z.string().optional(),
  // AI asset generation — fal.ai aggregator (image + video). Held server-side; the Studio's
  // cloud models are only offered when this is present. Generated media is downloaded into our
  // own storage as a SourceAsset(source="ai"). Cost is metadata only (no gating).
  FAL_KEY: z.string().optional(),
  FAL_QUEUE_BASE_URL: z.string().url().default("https://queue.fal.run"),
  // Lumio AI — multi-provider planner gateway (GP1). Each provider is enabled only when its key
  // is present; the gateway fails over in priority order. Model IDs are env-overridable because
  // free tiers drift. All endpoints are OpenAI-compatible (/v1/chat/completions).
  CEREBRAS_API_KEY: z.string().optional(),
  CEREBRAS_MODEL: z.string().default("llama-3.3-70b"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("meta-llama/llama-3.3-70b-instruct:free"),
  GEMINI_PLANNER_MODEL: z.string().default("gemini-2.5-flash"),
  // Lumio Brain B4 — the gateway's `fast` model class: small NON-reasoning instruct models for
  // tier-3 transactional compilation (one call, temperature 0, JSON only). Same keys as above.
  CEREBRAS_FAST_MODEL: z.string().default("llama3.1-8b"),
  GROQ_FAST_MODEL: z.string().default("llama-3.1-8b-instant"),
  OPENROUTER_FAST_MODEL: z.string().default("meta-llama/llama-3.1-8b-instruct:free"),
  GEMINI_FAST_MODEL: z.string().default("gemini-2.5-flash-lite"),
  // Premium last-hop (GP4); opt-in, used only when present.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_PLANNER_MODEL: z.string().default("claude-opus-4-8"),
  // Lumio AI debug logging. When set (or LOG_LEVEL=debug), the planner gateway logs every
  // provider attempt/failure and JSON-parse miss to the server console (keys/prompts never logged).
  LUMIO_AI_DEBUG: z
    .string()
    .optional()
    .transform((value) => value === "1" || value?.toLowerCase() === "true"),
  LOG_LEVEL: z.string().optional()
});

export const env = envSchema.parse(process.env);
