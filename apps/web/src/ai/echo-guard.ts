/**
 * Self-echo guard — the text-level tail defense of the "never hear ourselves" rule.
 *
 * The acoustic rule (mic and speaker never run at once — AiChatPanel's speak hold) covers the
 * body of a reply, but speakers keep emitting for a beat after the speak promise settles and
 * cancellation timing can't be made airtight, so the recognizer can still catch the TAIL of our
 * own speech and auto-submit it as a command. Real transcript (2026-07-12): the assistant said
 * "Moved clip 1 onto V3.", heard itself as "Move to clip 1 onto V3.", and re-executed the move —
 * three times. This module recognizes that shape: a transcript that is near-verbatim one of the
 * lines WE just spoke.
 *
 * Precision rules (a false positive eats a real user command, which is worse than one echo):
 * - only lines spoken within the last ECHO_WINDOW_MS count;
 * - the transcript needs ≥3 tokens ("yes"/"stop"/"go ahead" are never filtered);
 * - similarity is token-set based with light verb-suffix tolerance ("moved" ≈ "move"), and the
 *   bar is high (0.8 Dice) — a genuinely different command ("move clip 2 to V1" after we said
 *   "Moved clip 1 onto V3") scores ~0.4 and passes through.
 */

export interface SpokenLine {
  text: string;
  at: number;
}

const ECHO_WINDOW_MS = 6_000;
const MIN_TRANSCRIPT_TOKENS = 3;
const ECHO_SIMILARITY = 0.8;

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
    )
  ];
}

/** "moved" must match "move": a past-tense token also matches with its -d / -ed stripped. */
function tokenVariants(token: string): string[] {
  const variants = [token];
  if (token.length > 3 && /[a-z]ed$/.test(token)) {
    variants.push(token.slice(0, -1), token.slice(0, -2));
  }
  return variants;
}

function tokensMatch(a: string, b: string): boolean {
  const va = tokenVariants(a);
  const vb = tokenVariants(b);
  return va.some((variant) => vb.includes(variant));
}

/** Dice coefficient over token sets with suffix-tolerant matching (0..1). */
function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const remaining = [...b];
  let matched = 0;
  for (const token of a) {
    const index = remaining.findIndex((candidate) => tokensMatch(token, candidate));
    if (index !== -1) {
      matched += 1;
      remaining.splice(index, 1);
    }
  }
  return (2 * matched) / (a.length + b.length);
}

/**
 * True when `transcript` is almost certainly the assistant hearing its own recent speech.
 * `lines` come from tts.ts `recentlySpokenLines()`; `now` is injectable for tests.
 */
export function looksLikeSelfEcho(transcript: string, lines: SpokenLine[], now: number = performance.now()): boolean {
  const heard = tokenize(transcript);
  if (heard.length < MIN_TRANSCRIPT_TOKENS) {
    return false;
  }
  return lines.some((line) => {
    if (now - line.at > ECHO_WINDOW_MS) {
      return false;
    }
    return similarity(heard, tokenize(line.text)) >= ECHO_SIMILARITY;
  });
}
