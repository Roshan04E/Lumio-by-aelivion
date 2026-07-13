/**
 * GP3 — Bring Your Own Key. A user can supply their own free/paid provider key so
 * their AI requests run on THEIR quota instead of the shared pool (the scaling lever
 * for a public launch). The key lives only in this browser's localStorage and is
 * sent to our gateway per-request — never stored or logged server-side.
 */

export type ByoProvider = "cerebras" | "groq" | "openrouter" | "gemini" | "anthropic";

export interface ByoKeyConfig {
  provider: ByoProvider;
  apiKey: string;
  /** Optional model override; the gateway uses the provider default when omitted. */
  model?: string;
}

export const BYO_PROVIDERS: { id: ByoProvider; label: string; keyHint: string }[] = [
  { id: "groq", label: "Groq", keyHint: "console.groq.com — free, fast" },
  { id: "cerebras", label: "Cerebras", keyHint: "cloud.cerebras.ai — free, ~1M tok/day" },
  { id: "openrouter", label: "OpenRouter", keyHint: "openrouter.ai — many free models" },
  { id: "gemini", label: "Gemini", keyHint: "aistudio.google.com — free tier" },
  { id: "anthropic", label: "Claude (Anthropic)", keyHint: "console.anthropic.com — paid, best quality" }
];

const STORAGE_KEY = "kimera.ai.byok.v1";

export function loadByoKey(): ByoKeyConfig | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ByoKeyConfig;
    return parsed.apiKey && parsed.provider ? parsed : null;
  } catch {
    return null;
  }
}

export function saveByoKey(config: ByoKeyConfig): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* private mode / quota — best effort */
  }
}

export function clearByoKey(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
