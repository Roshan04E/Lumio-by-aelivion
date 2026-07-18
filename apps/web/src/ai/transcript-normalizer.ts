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
 *
 * FINAL-vs-INTERIM ARBITRATION (`arbitrateFinal`): Web Speech shows an interim the user
 * READS, then silently rewrites it with a "final" that is sometimes worse ("apply the neon
 * look" → interim "neon", final "new" — real report 2026-07-18; ChatGPT/Gemini voice input
 * shows the same class of bug). At final-time we hold TWO engine hypotheses, so instead of
 * blindly trusting the later one we arbitrate inside known command frames: keep the
 * interim's word only when it resolves against our own registries (look libraries, mood
 * recipes) AND the final's replacement does not. We never invent text — both candidates
 * came from the engine — and a resolvable final always wins, so wrong-fire requires the
 * engine to have heard a valid name it then replaced with an invalid one.
 */

import { listCreativeLooks, resolveLookName, resolveMoodRecipe, resolveTextLookName, TEXT_LOOK_NAMES } from "@orreris/shared";

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

// ---------------------------------------------------------------------------
// Command frames + registry resolution (the arbitration/bias vocabulary)
// ---------------------------------------------------------------------------

/** "apply/add/use/give (a|the) X look" — same shape as the router's APPLY_LOOK reflex. */
const LOOK_FRAME_RE = /\b(?:apply|add|use|give)\s+(?:it\s+|this\s+)?(?:an?\s+|the\s+)?(.{1,40}?)\s+look\b/i;
/** "make it/this (feel|look) X" — the K4 mood-ask frame. Tail-anchored (trailing punctuation ok). */
const MOOD_FRAME_RE = /\bmake\s+(?:it|this|everything)\s+(?:feel\s+|look\s+)?([a-z][a-z -]{2,24}?)(?:[.!?]\s*)?$/i;

function lookNameResolves(candidate: string): boolean {
  const name = candidate.trim();
  return name.length > 0 && (resolveLookName(name) !== null || resolveTextLookName(name) !== null);
}

function moodResolves(candidate: string): boolean {
  const name = candidate.trim();
  return name.length > 0 && (resolveMoodRecipe(name) !== null || resolveLookName(name) !== null);
}

interface CommandFrame {
  re: RegExp;
  resolves: (candidate: string) => boolean;
}

const COMMAND_FRAMES: readonly CommandFrame[] = [
  { re: LOOK_FRAME_RE, resolves: lookNameResolves },
  { re: MOOD_FRAME_RE, resolves: moodResolves }
];

/** Replace ONLY the frame's captured slot (group 1) inside the matched span. */
function replaceFrameSlot(text: string, match: RegExpExecArray, slot: string, replacement: string): string {
  const span = match[0];
  const slotIndex = span.toLowerCase().lastIndexOf(slot.toLowerCase());
  if (slotIndex < 0) {
    return text;
  }
  const patched = span.slice(0, slotIndex) + replacement + span.slice(slotIndex + slot.length);
  return text.slice(0, match.index) + patched + text.slice(match.index + span.length);
}

/**
 * Registry-anchored final-vs-interim arbitration. Both texts are ENGINE hypotheses for the
 * same utterance; inside a known command frame, the interim's slot wins only when it
 * resolves against the live registries and the final's slot does not ("neon" beats "new").
 * A resolvable final is always kept — the engine's second thoughts are usually right, we
 * only overrule it when it replaced a name we know with one we don't.
 */
export function arbitrateFinal(interim: string, final: string): string {
  const heard = interim.trim();
  if (!heard || heard.toLowerCase() === final.trim().toLowerCase()) {
    return final;
  }
  let out = final;
  for (const frame of COMMAND_FRAMES) {
    const inFinal = frame.re.exec(out);
    if (!inFinal) {
      continue;
    }
    const inInterim = frame.re.exec(heard);
    if (!inInterim) {
      continue;
    }
    const finalSlot = inFinal[1]!.trim();
    const interimSlot = inInterim[1]!.trim();
    if (finalSlot.toLowerCase() === interimSlot.toLowerCase()) {
      continue;
    }
    if (!frame.resolves(finalSlot) && frame.resolves(interimSlot)) {
      out = replaceFrameSlot(out, inFinal, finalSlot, interimSlot);
    }
  }
  return out;
}

/** Look names the frame-gated fuzzy pass may land on (built fresh — plugin looks count). */
function lookVocabulary(): string[] {
  return [...listCreativeLooks().map((look) => look.name), ...TEXT_LOOK_NAMES];
}

/** Inside the look frame ONLY: a distance-1 near-miss of a registry name corrects
 * ("neyon" → "Neon"). Distance stays 1 and the gate stays the frame — "new" (distance 2)
 * is NOT guessed at; that case needs interim evidence and belongs to `arbitrateFinal`. */
function biasLookFrame(text: string): string {
  const match = LOOK_FRAME_RE.exec(text);
  if (!match) {
    return text;
  }
  const slot = match[1]!.trim();
  if (slot.length < 3 || lookNameResolves(slot)) {
    return text;
  }
  const lower = slot.toLowerCase();
  for (const name of lookVocabulary()) {
    const target = name.toLowerCase();
    if (Math.abs(target.length - lower.length) <= 1 && levenshtein(lower, target) === 1) {
      return replaceFrameSlot(text, match, slot, name);
    }
  }
  return text;
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
  out = biasLookFrame(out);
  return out;
}
