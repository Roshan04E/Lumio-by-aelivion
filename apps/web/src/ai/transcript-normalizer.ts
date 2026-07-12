/**
 * Vocabulary biasing for dictation finals — the applicable half of "why does OpenAI hear
 * better". Big hosted ASR models let callers bias decoding toward domain vocabulary; the
 * browser's Web Speech engine offers no such control, so "V2" arrives as "be to" and "clip 1"
 * as "lip one" (real user transcript, 2026-07-12). This module rewrites those mishearings
 * DETERMINISTICALLY against the editor lexicon before the brain routes the text.
 *
 * PRECISION-FIRST (the brain's iron rule): every rule is context-gated so a missed correction
 * is possible but a WRONG correction is not — a missed fix just routes to the LLM, which
 * usually copes; a wrong fix corrupts a command. "lip" only corrects next to an ordinal
 * ("lip sync" survives); "be to" only corrects against a layer/track word ("be to the point"
 * survives). Pure module — covered by brain:eval with the real mishearing corpus.
 */

const ORDINAL_WORDS: Record<string, string> = {
  one: "1",
  won: "1",
  juan: "1",
  two: "2",
  to: "2",
  too: "2",
  three: "3",
  free: "3",
  four: "4",
  for: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  ate: "8",
  nine: "9",
  ten: "10"
};

function ordinalToDigits(word: string): string {
  return /^\d+$/.test(word) ? word : (ORDINAL_WORDS[word.toLowerCase()] ?? word);
}

/** After "clip", only UNAMBIGUOUS number words count — "to/for/free/ate" are everyday function
 * words there ("trim the clip to 4 seconds" must never become "clip 2 4 seconds"). */
const CLIP_SAFE_ORDINALS = "\\d+|one|won|juan|two|three|four|five|six|seven|eight|nine|ten";

/** "clip one" / "lip won" / "klip 2" → "clip N". The ordinal REQUIREMENT is the gate — bare
 * "lip"/"lips" (lip sync, lips) never corrects. */
const CLIP_ORDINAL_RE = new RegExp(`\\b(?:clips?|lips?|klips?|glip)\\s+(${CLIP_SAFE_ORDINALS})\\b`, "gi");

/** V/A track mishearings, gated by an adjacent layer/track word: "be to layer" → "V2 layer",
 * "layer we too" → "layer V2". Without that neighbor, "we two"/"be to" stay untouched. */
const TRACK_NUM = "one|won|juan|to|too|two|three|free|1|2|3";
const V_ALTS = "v|vee|we|b|be|bee";
const A_ALTS = "a|ay";
const V_BEFORE_RE = new RegExp(`\\b(?:${V_ALTS})\\s+(${TRACK_NUM})\\s+(layers?|tracks?)\\b`, "gi");
const V_AFTER_RE = new RegExp(`\\b(layers?|tracks?)\\s+(?:${V_ALTS})\\s+(${TRACK_NUM})\\b`, "gi");
const A_BEFORE_RE = new RegExp(`\\b(?:${A_ALTS})\\s+(${TRACK_NUM})\\s+(layers?|tracks?)\\b`, "gi");
const A_AFTER_RE = new RegExp(`\\b(layers?|tracks?)\\s+(?:${A_ALTS})\\s+(${TRACK_NUM})\\b`, "gi");

/** Editor terms Web Speech loves to split in half. */
const JOIN_RULES: Array<[RegExp, string]> = [
  [/\bplay ?head\b/gi, "playhead"],
  [/\bkey ?frame(s?)\b/gi, "keyframe$1"],
  [/\btime ?line\b/gi, "timeline"],
  [/\bplay ?back\b/gi, "playback"]
];

/** Single-token fuzzy pass: distance ≤1 to a high-value editor term, token ≥5 chars, and the
 * token must NOT itself be an everyday word (precision guard). */
const EDITOR_TERMS = [
  "playhead",
  "keyframe",
  "keyframes",
  "opacity",
  "timeline",
  "transition",
  "transitions",
  "caption",
  "captions",
  "inspector",
  "inspectors",
  "snapping",
  "playback",
  "timelines"
];
const EVERYDAY_WORDS = new Set([
  "options",
  "option",
  "capture",
  "position",
  "tradition",
  "traditions",
  "capacity",
  "inspection",
  "translation",
  "translations",
  "snapshot",
  "caution",
  "cautions",
  "napping",
  "slapping",
  "payback"
]);

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    let prevDiag = dist[0]!;
    dist[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const temp = dist[j]!;
      dist[j] = Math.min(dist[j]! + 1, dist[j - 1]! + 1, prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1));
      prevDiag = temp;
    }
  }
  return dist[cols - 1]!;
}

function fuzzyEditorTerm(token: string): string | null {
  const lower = token.toLowerCase();
  if (lower.length < 5 || EVERYDAY_WORDS.has(lower) || EDITOR_TERMS.includes(lower)) {
    return null;
  }
  for (const term of EDITOR_TERMS) {
    if (Math.abs(term.length - lower.length) <= 1 && levenshtein(lower, term) === 1) {
      return term;
    }
  }
  return null;
}

/** Normalize one dictation FINAL against the editor lexicon. Deterministic and conservative —
 * unrecognized text passes through byte-identical. */
export function normalizeTranscript(text: string): string {
  let out = text;
  for (const [pattern, replacement] of JOIN_RULES) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(CLIP_ORDINAL_RE, (_match, num: string) => `clip ${ordinalToDigits(num)}`);
  out = out.replace(V_BEFORE_RE, (_match, num: string, tail: string) => `V${ordinalToDigits(num)} ${tail}`);
  out = out.replace(V_AFTER_RE, (_match, head: string, num: string) => `${head} V${ordinalToDigits(num)}`);
  out = out.replace(A_BEFORE_RE, (_match, num: string, tail: string) => `A${ordinalToDigits(num)} ${tail}`);
  out = out.replace(A_AFTER_RE, (_match, head: string, num: string) => `${head} A${ordinalToDigits(num)}`);
  out = out.replace(/\b[a-zA-Z]{5,}\b/g, (token) => fuzzyEditorTerm(token) ?? token);
  return out;
}
