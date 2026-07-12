import { buildConsultantUserContent, CONSULTANT_SYSTEM_PROMPT } from "@lumio-by-aelivion/shared";
import { loadByoKey } from "./byok";
import { isOllamaLocalActive, loadOllamaConfig, streamOllamaChat } from "./ollama";
import type { PlannerContext } from "./types";

/**
 * Talk mode client. Streams a conversational reply from `/ai/chat/stream` (the
 * "creative consultant" — ideas, not edits) and parses the trailing
 * `SUGGESTIONS:` line into clickable, runnable prompts. It never mutates the
 * timeline; it's pure inspiration that can hand off to the planner on a tap.
 */

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4100/api";

export interface TalkResult {
  text: string;
  suggestions: string[];
  /** "unavailable" → no provider; "vision" → image attached but no vision model. */
  status: "ok" | "unavailable" | "vision";
}

export interface TalkOptions {
  /** Streamed prose deltas, for live rendering. */
  onDelta?: (delta: string) => void;
  /** Reference images (data URLs). */
  images?: string[] | undefined;
  /** Local mode (Ollama): converse with the user's local model browser-direct; falls back to cloud on failure. */
  useLocal?: boolean | undefined;
}

/**
 * Lift the `SUGGESTIONS:` tail off the reply, returning clean prose + the parsed list. Tolerant of
 * local models (e.g. minimax) that leave the JSON array unterminated or trail extra prose: it locates
 * the marker anywhere, recovers an unclosed `[...]`, and falls back to salvaging quoted strings (then
 * line/comma splitting) so suggestions still become clickable chips.
 */
export function parseSuggestions(raw: string): { text: string; suggestions: string[] } {
  const markerIndex = raw.search(/SUGGESTIONS:/i);
  if (markerIndex === -1) {
    return { text: raw.trim(), suggestions: [] };
  }
  const text = raw.slice(0, markerIndex).trim();
  const tail = raw.slice(markerIndex).replace(/SUGGESTIONS:/i, "").trim();

  let suggestions: string[] = [];
  const arrayStart = tail.indexOf("[");
  if (arrayStart !== -1) {
    const fromBracket = tail.slice(arrayStart);
    const closeIndex = fromBracket.lastIndexOf("]");
    // Recover an unterminated array by appending the missing close bracket.
    const candidate = closeIndex > 0 ? fromBracket.slice(0, closeIndex + 1) : `${fromBracket}]`;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        suggestions = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      /* fall through to salvage */
    }
  }
  if (suggestions.length === 0) {
    // Salvage every double-quoted string; else split on newlines/commas and strip bullets/brackets.
    const quoted = [...tail.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => item[1]!);
    suggestions = quoted.length
      ? quoted
      : tail
          .split(/[\n,]/)
          .map((item) => item.replace(/^[\s\-*\d.)\]]+/, "").replace(/[[\]"]+/g, "").trim())
          .filter(Boolean);
  }
  suggestions = suggestions.map((item) => item.trim()).filter(Boolean).slice(0, 4);
  return { text, suggestions };
}

export async function streamTalk(prompt: string, ctx: PlannerContext, options: TalkOptions = {}): Promise<TalkResult> {
  // Local mode (Ollama): converse with the user's local model directly. On any failure we fall through
  // to the cloud gateway below, so the editor never blocks.
  if (options.useLocal && isOllamaLocalActive()) {
    const local = await streamTalkLocal(prompt, ctx, options);
    if (local) {
      return local;
    }
  }

  const byo = loadByoKey();
  const payload = {
    prompt,
    ...(summarize(ctx) ? { context: summarize(ctx) } : {}),
    ...(ctx.memoryNote ? { memoryNote: ctx.memoryNote } : {}),
    history: (ctx.history ?? []).slice(-8),
    ...(byo ? { byo } : {}),
    ...(ctx.memory?.qualityMode === "best" ? { premium: true } : {}),
    ...(options.images && options.images.length ? { images: options.images } : {}),
    ...(ctx.voiceMode ? { voiceMode: true } : {})
  };

  let response: Response;
  try {
    response = await fetch(`${API_URL}/ai/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    return { text: "", suggestions: [], status: "unavailable" };
  }
  if (!response.ok || !response.body) {
    return { text: "", suggestions: [], status: "unavailable" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let message = "";
  let status: TalkResult["status"] = "ok";

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: { e?: string; delta?: string; reason?: string };
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (event.e === "message" && typeof event.delta === "string") {
        const hadMarker = /SUGGESTIONS:/i.test(message);
        message += event.delta;
        // Stop streaming into the visible bubble once the SUGGESTIONS tail begins.
        if (!hadMarker) {
          options.onDelta?.(event.delta);
        }
      } else if (event.e === "unavailable") {
        status = event.reason === "vision" ? "vision" : "unavailable";
      }
    }
  }

  if (status !== "ok") {
    return { text: "", suggestions: [], status };
  }
  const { text, suggestions } = parseSuggestions(message);
  // Nothing actually streamed (e.g. provider committed then died) → treat as unavailable.
  if (!text.trim()) {
    return { text: "", suggestions: [], status: "unavailable" };
  }
  return { text, suggestions, status: "ok" };
}

/**
 * Talk mode against the user's local Ollama model. Streams prose (stopping the visible bubble at the
 * SUGGESTIONS tail, like the cloud path) and parses the runnable suggestions. Returns null on any
 * failure so the caller transparently falls back to the cloud gateway.
 */
async function streamTalkLocal(prompt: string, ctx: PlannerContext, options: TalkOptions): Promise<TalkResult | null> {
  const config = loadOllamaConfig();
  if (!config) {
    return null;
  }
  const summary = summarize(ctx);
  const user = buildConsultantUserContent({
    prompt,
    ...(summary ? { context: summary } : {}),
    ...(ctx.memoryNote ? { memoryNote: ctx.memoryNote } : {}),
    history: (ctx.history ?? []).slice(-8),
    ...(ctx.voiceMode ? { voiceMode: true } : {})
  });
  let message = "";
  try {
    const result = await streamOllamaChat(
      { baseUrl: config.baseUrl, model: config.model, system: CONSULTANT_SYSTEM_PROMPT, user, ...(options.images?.length ? { images: options.images } : {}) },
      {
        onContent: (delta) => {
          const hadMarker = /SUGGESTIONS:/i.test(message);
          message += delta;
          // Stop streaming into the visible bubble once the SUGGESTIONS tail begins.
          if (!hadMarker) {
            options.onDelta?.(delta);
          }
        }
      }
    );
    // Prefer the assembled text (handles models that don't stream content deltas).
    const raw = result.text.trim() || message;
    const { text, suggestions } = parseSuggestions(raw);
    if (!text.trim()) {
      return null;
    }
    return { text, suggestions, status: "ok" };
  } catch {
    return null;
  }
}

/** A tiny timeline summary so the consultant grounds advice in the actual project. */
function summarize(ctx: PlannerContext): string {
  const layers = ctx.composition.tracks.flatMap((track) => track.layers);
  if (!layers.length) return "Empty timeline.";
  const byType = layers.reduce<Record<string, number>>((acc, layer) => {
    acc[layer.type] = (acc[layer.type] ?? 0) + 1;
    return acc;
  }, {});
  const counts = Object.entries(byType)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
  return `${layers.length} layers (${counts}); ${ctx.composition.durationSeconds.toFixed(0)}s.`;
}
