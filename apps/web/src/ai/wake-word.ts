/**
 * "Hey Kimera" wake-word matcher — pure and eval-tested (router-eval.test.ts).
 *
 * Web Speech never hears the brand name cleanly: "hey kimera" (spoken like "chimera") comes back
 * as "hey chimera", "hey camera", "hello kimira", "hey kimmer". So matching is three-layered:
 *   1. a builtin variant set (every observed/adjacent mishearing, incl. the "chimera"/"camera" homophones),
 *   2. edit-distance ≤ 2 from "kimera" for k-/c-initial tokens (catches new mishearings),
 *   3. LEARNED phrases — exact transcripts the user confirmed via the "were you calling me?"
 *      card, persisted per browser. This is how the user trains the ear to THEIR voice/accent.
 *
 * Precision guard: a greeting token (hey/hello/…) is REQUIRED before the name — the only thing
 * a match does is open the voice session, but ambient speech still shouldn't flicker it.
 */

const GREETINGS = new Set(["hey", "heya", "hello", "hi", "hiya", "hay", "aye", "okay", "ok", "yo"]);

/** Observed mishearings + close neighbours. The c-initial homophones (chimera/camera/cimera) are
 * safe here because the greeting requirement already anchors the phrase shape — only the distinctive
 * k-initial tokens are allowed to wake WITHOUT a greeting (isStrongNameToken). */
const NAME_VARIANTS = new Set([
  "kimera",
  "kimira",
  "kymera",
  "kimmera",
  "kimerra",
  "kemera",
  "khimera",
  "kimara",
  "kimero",
  "kimmer",
  "chimera",
  "cimera",
  "camera"
]);

export interface WakeWordMatch {
  matched: boolean;
  /** Trailing words after the name — "hey kimera blur clip 2" → "blur clip 2". */
  command?: string;
}

const NO_MATCH: WakeWordMatch = { matched: false };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = new Array<number>(rows * cols).fill(0);
  for (let i = 0; i < rows; i += 1) dist[i * cols] = i;
  for (let j = 0; j < cols; j += 1) dist[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i * cols + j] = Math.min(dist[(i - 1) * cols + j]! + 1, dist[i * cols + j - 1]! + 1, dist[(i - 1) * cols + j - 1]! + cost);
    }
  }
  return dist[rows * cols - 1]!;
}

function isNameToken(token: string): boolean {
  if (NAME_VARIANTS.has(token)) {
    return true;
  }
  return token.length >= 4 && (token.startsWith("k") || token.startsWith("c")) && levenshtein(token, "kimera") <= 2;
}

/** k-initial variants are distinctive enough to wake WITHOUT a greeting ("Kimera, pause");
 * the c-initial homophones (chimera/camera) stay greeting-anchored to avoid ambient false wakes. */
function isStrongNameToken(token: string): boolean {
  return token.startsWith("k") && token.length >= 4 && isNameToken(token);
}

/**
 * Match a heard transcript against the wake phrase. `learnedPhrases` are exact normalized
 * transcripts the user confirmed; a learned phrase matches when the transcript starts with it.
 */
export function matchWakeWord(transcript: string, learnedPhrases: readonly string[] = []): WakeWordMatch {
  const normalized = normalize(transcript);
  if (!normalized) {
    return NO_MATCH;
  }

  for (const learned of learnedPhrases) {
    if (learned && (normalized === learned || normalized.startsWith(`${learned} `))) {
      const command = normalized.slice(learned.length).trim();
      return command ? { matched: true, command } : { matched: true };
    }
  }

  const tokens = normalized.split(" ");
  // Name-first wake ("Kimera, pause") — no greeting needed for the distinctive k-variants.
  if (isStrongNameToken(tokens[0]!)) {
    const command = tokens.slice(1).join(" ").trim();
    return command ? { matched: true, command } : { matched: true };
  }
  for (let i = 0; i < tokens.length - 1 && i < 3; i += 1) {
    if (!GREETINGS.has(tokens[i]!)) {
      continue;
    }
    const next = tokens[i + 1]!;
    // Single name token after the greeting.
    if (isNameToken(next)) {
      const command = tokens.slice(i + 2).join(" ").trim();
      return command ? { matched: true, command } : { matched: true };
    }
    // Split name ("kim era", "ki mera") — join the next two tokens.
    const pair = tokens[i + 2] ? next + tokens[i + 2]! : "";
    if (pair && isNameToken(pair)) {
      const command = tokens.slice(i + 3).join(" ").trim();
      return command ? { matched: true, command } : { matched: true };
    }
  }
  return NO_MATCH;
}

/** A short greeting-led utterance that DIDN'T match — worth asking "were you calling me?". */
export function looksLikeWakeAttempt(transcript: string): boolean {
  const normalized = normalize(transcript);
  if (!normalized) {
    return false;
  }
  const tokens = normalized.split(" ");
  return tokens.length >= 2 && tokens.length <= 4 && GREETINGS.has(tokens[0]!) && !matchWakeWord(normalized).matched;
}

// ---------------------------------------------------------------------------
// Learned phrases — the user's confirmed mishearings ("hello camera" → wakes)
// ---------------------------------------------------------------------------

const WAKE_PHRASES_KEY = "kimera.voice.wakephrases.v1";
const MAX_WAKE_PHRASES = 12;

let memoryWakePhrases: string[] = [];

export function loadWakePhrases(): string[] {
  try {
    if (typeof localStorage !== "undefined") {
      const parsed: unknown = JSON.parse(localStorage.getItem(WAKE_PHRASES_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    }
  } catch {
    // fall through
  }
  return memoryWakePhrases;
}

function saveWakePhrases(phrases: string[]): void {
  const bounded = phrases.slice(-MAX_WAKE_PHRASES);
  memoryWakePhrases = bounded;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(WAKE_PHRASES_KEY, JSON.stringify(bounded));
    }
  } catch {
    // best-effort
  }
}

/** Store a confirmed mishearing (normalized) so it wakes the session from now on. */
export function learnWakePhrase(heard: string): void {
  const normalized = normalize(heard);
  if (!normalized || normalized.split(" ").length > 4) {
    return;
  }
  saveWakePhrases([...loadWakePhrases().filter((entry) => entry !== normalized), normalized]);
}

export function clearWakePhrases(): void {
  saveWakePhrases([]);
}

// ---------------------------------------------------------------------------
// Wake-word enable flag — shared by the panel (Ear toggle) and EditorPage
// (which must keep the AI dock mounted for standby even with the chat closed)
// ---------------------------------------------------------------------------

const WAKE_ENABLED_KEY = "kimera.voice.wakeword.v1";

export function loadWakeWordEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(WAKE_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveWakeWordEnabled(on: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(WAKE_ENABLED_KEY, on ? "1" : "0");
    }
  } catch {
    // best-effort
  }
}
