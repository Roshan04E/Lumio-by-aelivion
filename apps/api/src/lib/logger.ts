import { env } from "../config/env";

/**
 * Orreris AI — tiny debug logger for the planner gateway. The whole AI failure path
 * (provider HTTP errors, timeouts, empty completions, JSON-parse misses) used to be
 * swallowed into bare `catch {}` blocks, so there was no way to see *why* a request
 * produced no plan. `aiLog.debug` is silent unless `ORRERIS_AI_DEBUG=1` (or
 * `LOG_LEVEL=debug`); `aiLog.warn` always prints. Never log API keys or full prompts —
 * use `promptHash()` for a stable, non-reversible reference.
 */

const debugEnabled = env.ORRERIS_AI_DEBUG === true || env.LOG_LEVEL?.toLowerCase() === "debug";

/** A short, stable, non-reversible reference to a prompt — safe to log for correlation. */
export function promptHash(prompt: string): string {
  let hash = 5381;
  for (let i = 0; i < prompt.length; i += 1) {
    hash = ((hash << 5) + hash + prompt.charCodeAt(i)) | 0;
  }
  return `p${(hash >>> 0).toString(36)}`;
}

/** Truncate a model reply for a log line so we never dump a full response. */
export function snippet(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export const aiLog = {
  /** Verbose per-attempt tracing — only when debug logging is enabled. */
  debug(...parts: unknown[]): void {
    if (debugEnabled) {
      // eslint-disable-next-line no-console
      console.log("[ai]", ...parts);
    }
  },
  /** Always-on — for total pool exhaustion / unrecoverable misses worth surfacing in prod. */
  warn(...parts: unknown[]): void {
    // eslint-disable-next-line no-console
    console.warn("[ai]", ...parts);
  }
};
