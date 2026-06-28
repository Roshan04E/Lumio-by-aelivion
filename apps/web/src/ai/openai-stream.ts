/**
 * Browser-side OpenAI-compatible SSE consumer.
 *
 * Ported from the server gateway's `consumeSse` (apps/api/src/services/aiGateway.service.ts) so the
 * Local (Ollama) path parses streaming `/v1/chat/completions` deltas exactly like the cloud path:
 * reasoning vs answer deltas, with inline `<think>…</think>` reasoning stripped from the answer.
 */

export interface OpenAiStreamHandlers {
  /** Reasoning-token delta (live "thinking"). */
  onReasoning?: ((delta: string) => void) | undefined;
  /** Fired once when the first answer (non-reasoning) token arrives. */
  onAnswerStart?: (() => void) | undefined;
  /** Answer-token delta (prose / plan JSON, streamed live). */
  onContent?: ((delta: string) => void) | undefined;
}

const REASONING_CAP = 3000;

/** Parse an OpenAI-compatible SSE body, streaming deltas to handlers, returning the assembled answer. */
export async function consumeOpenAiSse(
  body: ReadableStream<Uint8Array>,
  handlers: OpenAiStreamHandlers
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
      }
    }
  }

  const inlineThink = content.match(/<think>([\s\S]*?)<\/think>/i)?.[1] ?? "";
  const fullReasoning = [reasoning, inlineThink].filter((part) => part.trim()).join("\n").trim().slice(0, REASONING_CAP);
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return fullReasoning ? { text, reasoning: fullReasoning } : { text };
}
