/**
 * Local LLM via Ollama — "Local" mode.
 *
 * Ollama runs on the user's machine (default `http://localhost:11434`) and exposes an
 * OpenAI-compatible `/v1/chat/completions` endpoint, so it's "just another provider" — except our
 * remote server can't reach a user's localhost, so the BROWSER talks to it directly. This keeps Local
 * mode fully private/offline. Config lives only in this browser (localStorage), like `byok.ts`.
 *
 * The user must start Ollama allowing our origin, e.g. `OLLAMA_ORIGINS=<web origin> ollama serve`,
 * otherwise the browser's cross-origin request is blocked by CORS.
 */

import { consumeOpenAiSse, type OpenAiStreamHandlers } from "./openai-stream";

export interface OllamaConfig {
  /** Host root, no trailing slash (chat → `${baseUrl}/v1/chat/completions`, tags → `${baseUrl}/api/tags`). */
  baseUrl: string;
  model: string;
  /** Whether Local mode is currently the active route (toggled by the "Local" button). */
  enabled: boolean;
  /** Whether the chosen model accepts image input (multimodal). */
  supportsVision: boolean;
}

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const STORAGE_KEY = "orreris.ai.ollama.v1";

export function loadOllamaConfig(): OllamaConfig | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OllamaConfig>;
    if (!parsed.baseUrl || !parsed.model) return null;
    return {
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      model: parsed.model,
      enabled: Boolean(parsed.enabled),
      supportsVision: Boolean(parsed.supportsVision)
    };
  } catch {
    return null;
  }
}

export function saveOllamaConfig(config: OllamaConfig): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...config, baseUrl: normalizeBaseUrl(config.baseUrl) }));
  } catch {
    /* private mode / quota — best effort */
  }
}

export function clearOllamaConfig(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Local mode is the active route only when configured AND toggled on. */
export function isOllamaLocalActive(): boolean {
  const config = loadOllamaConfig();
  return Boolean(config?.enabled && config.model);
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

interface OllamaTag {
  name?: string;
  model?: string;
  details?: { families?: string[] | null; family?: string | null } | null;
}

/** A model is vision-capable if its families/name reference a known multimodal family. */
function inferVision(tag: OllamaTag): boolean {
  const families = [tag.details?.family, ...(tag.details?.families ?? [])].filter(Boolean).map((value) => String(value).toLowerCase());
  const name = (tag.name ?? tag.model ?? "").toLowerCase();
  const visionMarkers = ["clip", "vision", "llava", "minicpm", "mllama", "qwen2-vl", "qwen2.5vl", "gemma3"];
  return visionMarkers.some((marker) => families.some((family) => family.includes(marker)) || name.includes(marker));
}

export interface OllamaModel {
  name: string;
  supportsVision: boolean;
}

/** List locally-pulled models via Ollama's native `/api/tags`. Throws if unreachable. */
export async function listOllamaModels(baseUrl: string): Promise<OllamaModel[]> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/tags`, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Ollama responded ${response.status}`);
  }
  const json = (await response.json()) as { models?: OllamaTag[] };
  return (json.models ?? [])
    .map((tag) => ({ name: tag.name ?? tag.model ?? "", supportsVision: inferVision(tag) }))
    .filter((model) => model.name);
}

/** Fast reachability probe (aborts after `timeoutMs`). Used for the pre-flight before a run. */
export async function pingOllama(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/tags`, { method: "GET", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface OllamaChatRequest {
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  /** Reference images as data URLs → sent as multimodal `image_url` parts. */
  images?: string[] | undefined;
  signal?: AbortSignal | undefined;
}

/** Build the OpenAI-compatible user content: a string, or a multimodal array when images are attached. */
function buildUserContent(user: string, images: string[] | undefined): unknown {
  if (!images || images.length === 0) {
    return user;
  }
  return [{ type: "text", text: user }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
}

/**
 * Stream a chat completion directly from the user's Ollama. Mirrors the gateway's request shape so the
 * SAME system prompt + user content yields comparable output. Throws on any transport/HTTP failure so
 * callers can fall back to the cloud pool.
 */
export async function streamOllamaChat(request: OllamaChatRequest, handlers: OpenAiStreamHandlers): Promise<{ text: string; reasoning?: string }> {
  const response = await fetch(`${normalizeBaseUrl(request.baseUrl)}/v1/chat/completions`, {
    method: "POST",
    ...(request.signal ? { signal: request.signal } : {}),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: request.model,
      stream: true,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: buildUserContent(request.user, request.images) }
      ]
    })
  });
  if (!response.ok || !response.body) {
    // 403 = Ollama's CORS gate: browser requests carry an Origin header, and Ollama only
    // accepts origins listed in OLLAMA_ORIGINS. Tell the user the actual fix once — otherwise
    // Local mode just silently falls back to the cloud and looks broken.
    if (response.status === 403 && !warnedCors) {
      warnedCors = true;
      console.warn(
        "[orreris] Ollama rejected the browser request (403 — CORS). Allow this origin and restart Ollama:\n" +
          '  Windows:  setx OLLAMA_ORIGINS "*"   (then quit the Ollama tray app and start it again)\n' +
          "  mac/linux:  OLLAMA_ORIGINS=* ollama serve\n" +
          `  (or list the exact origin, e.g. "${typeof location !== "undefined" ? location.origin : "http://localhost:5173"}")`
      );
      // Surface it to the USER too (once) — a silent cloud fallback makes Local look broken.
      for (const listener of corsBlockedListeners) {
        try {
          listener();
        } catch {
          // listener errors must not break the fallback path
        }
      }
    }
    throw new Error(response.status === 403 ? "Ollama blocked the browser (403) — set OLLAMA_ORIGINS and restart Ollama" : `Ollama chat failed: HTTP ${response.status}`);
  }
  return consumeOpenAiSse(response.body, handlers);
}

/** One console warning per session — the 403 fires on every local call otherwise. */
let warnedCors = false;
const corsBlockedListeners = new Set<() => void>();

/** Notifies ONCE per session when Ollama rejects the browser with 403 (CORS) — the chat panel
 * turns this into a visible notice with the fix, instead of a silent cloud fallback. */
export function onOllamaCorsBlocked(listener: () => void): () => void {
  corsBlockedListeners.add(listener);
  if (warnedCors) {
    listener(); // already happened this session — replay so a late-mounting panel still shows it
  }
  return () => corsBlockedListeners.delete(listener);
}
