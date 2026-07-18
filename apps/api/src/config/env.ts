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

/** Treat a blank env value (`FOO=`) as unset, so an empty optional URL doesn't fail validation. */
function emptyAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4100),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4100"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://orreris:orreris@localhost:5432/orreris?schema=public"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(16).default("local-dev-secret-change-me"),
  STORAGE_ROOT: z.string().default("apps/api/storage"),
  // Object storage driver. "local" = on-disk (dev default, unchanged). "r2" = Cloudflare R2
  // (S3-compatible) — only active when the R2_* creds below are present. Media stays LOCAL-FIRST
  // in the browser regardless; this only backs the opt-in "upload to cloud" path.
  STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
  // Empty-string env values (a blank `R2_ENDPOINT=`) must read as "unset", not fail url() validation.
  R2_ENDPOINT: emptyAsUndefined(z.string().url().optional()), // https://<accountid>.r2.cloudflarestorage.com
  R2_BUCKET: emptyAsUndefined(z.string().optional()),
  R2_ACCESS_KEY_ID: emptyAsUndefined(z.string().optional()),
  R2_SECRET_ACCESS_KEY: emptyAsUndefined(z.string().optional()),
  // Optional stable public base (R2 public dev URL or custom domain). When set, uploaded media is
  // served directly from it; otherwise the API proxies reads (works with a private bucket).
  R2_PUBLIC_BASE_URL: emptyAsUndefined(z.string().url().optional()),
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
  // Orreris AI — multi-provider planner gateway (GP1). Each provider is enabled only when its key
  // is present; the gateway fails over in priority order. Model IDs are env-overridable because
  // free tiers drift. All endpoints are OpenAI-compatible (/v1/chat/completions).
  CEREBRAS_API_KEY: z.string().optional(),
  CEREBRAS_MODEL: z.string().default("llama-3.3-70b"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("meta-llama/llama-3.3-70b-instruct:free"),
  GEMINI_PLANNER_MODEL: z.string().default("gemini-2.5-flash"),
  // Orreris Brain B4 — the gateway's `fast` model class: small NON-reasoning instruct models for
  // tier-3 transactional compilation (one call, temperature 0, JSON only). Same keys as above.
  CEREBRAS_FAST_MODEL: z.string().default("llama3.1-8b"),
  GROQ_FAST_MODEL: z.string().default("llama-3.1-8b-instant"),
  OPENROUTER_FAST_MODEL: z.string().default("meta-llama/llama-3.1-8b-instruct:free"),
  GEMINI_FAST_MODEL: z.string().default("gemini-2.5-flash-lite"),
  // Premium last-hop (GP4); opt-in, used only when present.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_PLANNER_MODEL: z.string().default("claude-opus-4-8"),
  // Orreris AI debug logging. When set (or LOG_LEVEL=debug), the planner gateway logs every
  // provider attempt/failure and JSON-parse miss to the server console (keys/prompts never logged).
  ORRERIS_AI_DEBUG: z
    .string()
    .optional()
    .transform((value) => value === "1" || value?.toLowerCase() === "true"),
  LOG_LEVEL: z.string().optional()
});

export const env = envSchema.parse(process.env);
