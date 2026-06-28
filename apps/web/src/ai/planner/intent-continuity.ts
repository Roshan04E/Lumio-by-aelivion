/**
 * Phase 10 — Intent Continuity. A pure, synchronous pre-classifier that decides,
 * per message, whether the user is CONTINUING the previous request ("make it
 * bigger", "recolor it green") or starting a NEW one ("add a blue box"). It runs
 * on the client BEFORE either planner so it can gate what conversational context
 * is injected — most importantly whether the previous edit's target (`lastAction`)
 * is threaded in at all. Getting this wrong silently edits the wrong layer, so the
 * tie-break is deliberately conservative: when unsure, treat it as NEW.
 *
 * No wink/NLU here — this must be cheap and sync (it gates the network call), and
 * it runs for the LLM path too. Signals are compact keyword/regex scans.
 */

export type IntentScope = "continue" | "new";

export interface ContinuityResult {
  scope: IntentScope;
  /** 0–1 — how strongly the winning scope beat the other (margin-based). */
  confidence: number;
  /** Short human reason, for the debug log / "↪ continuing your last edit" note. */
  reason: string;
}

export interface ContinuitySignals {
  /** Is there a previous applied plan whose target we could continue editing? */
  hasLastAction: boolean;
  /** Did the user explicitly select a layer? (an explicit pointer at "this".) */
  hasSelection: boolean;
}

// A fresh OBJECT the user is introducing → a new layer/tool, regardless of recency.
const SHAPE_KIND = /\b(shape|circle|square|rectangle|rect|box|pill|capsule|ellipse|oval|ring|dot|disc|disk|banner|badge|blob)\b/;
const CONTENT_MARKER = /["“”']|\b(saying|that says|that reads|reads|says|titled|labelled|labeled)\b/;
const TOOL_NOUN = /\b(caption|captions|subtitle|subtitles|transcribe|transcript|background|track|tracking|follow|reframe|grade)\b/;
// "add/create/insert/draw/put/place/write a|an|new|another <something>"
const ADD_NEW_OBJECT = /\b(add|create|insert|draw|put|place|write|generate|make)\b.*\b(a|an|new|another|some)\b/;

// The user is pointing back at what just happened → continue the previous request.
const LEADING_CONNECTIVE = /^\s*(also|and|then|now|plus|instead|but|additionally|after that)\b/;
const DELTA_PHRASE =
  /\b(bigger|smaller|larger|tinier|wider|narrower|taller|shorter|brighter|darker|bolder|more|less|again|too|as well|the same)\b/;
const PRONOUN_OBJECT = /\b(it|this|that|them|those|these|its)\b/;
// "make/keep it …", "change/move/recolor/resize it …" — an edit verb aimed at a pronoun.
const EDIT_PRONOUN = /\b(make|keep|change|move|recolor|recolour|resize|set|turn|put|center|centre|tweak|adjust)\b[^.]*\b(it|this|that|them|those|these)\b/;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Classify whether `prompt` continues the last request or starts a new one.
 * `new` is the safe default when there's nothing to continue or the signals tie.
 */
export function classifyContinuity(prompt: string, signals: ContinuitySignals): ContinuityResult {
  const text = prompt.toLowerCase().trim();

  // A fresh object marker is a strong, recency-independent "new" signal.
  const introducesNewObject =
    SHAPE_KIND.test(text) || CONTENT_MARKER.test(text) || TOOL_NOUN.test(text) || ADD_NEW_OBJECT.test(text);

  // Nothing to continue → it's a new request by definition.
  if (!signals.hasLastAction && !signals.hasSelection) {
    return { scope: "new", confidence: 0.9, reason: "no prior edit to continue" };
  }

  // An explicit selection with no new object is the user pointing at "this" → continue.
  if (signals.hasSelection && !introducesNewObject) {
    return { scope: "continue", confidence: 0.85, reason: "edits the selected layer" };
  }

  let newScore = 0;
  let continueScore = 0;
  const reasons: string[] = [];

  if (introducesNewObject) {
    newScore += 2;
    reasons.push("introduces a new object");
  }
  if (signals.hasLastAction) {
    if (LEADING_CONNECTIVE.test(text)) {
      continueScore += 1.5;
      reasons.push("leads with a connective");
    }
    if (EDIT_PRONOUN.test(text)) {
      continueScore += 2;
      reasons.push("edit verb aimed at 'it/this'");
    } else if (PRONOUN_OBJECT.test(text) && !introducesNewObject) {
      continueScore += 1.5;
      reasons.push("refers back with a pronoun");
    }
    if (DELTA_PHRASE.test(text)) {
      continueScore += 1;
      reasons.push("delta phrasing");
    }
  }

  // Tie or no continue evidence → NEW (never silently edit the wrong thing).
  const scope: IntentScope = continueScore > newScore ? "continue" : "new";
  const winner = Math.max(continueScore, newScore);
  const loser = Math.min(continueScore, newScore);
  const confidence = clamp01(winner === 0 ? 0.6 : (winner - loser) / winner);
  const reason = reasons.length ? reasons.join(", ") : scope === "new" ? "no continuation signal" : "continuation signal";
  return { scope, confidence, reason };
}
