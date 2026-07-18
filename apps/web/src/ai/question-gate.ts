/**
 * Question gate (P0, real transcript 2026-07-18): question-shaped prompts must NEVER enter
 * the edit-plan pipeline. The failure it kills: "Analyze clip 5 and tell me how many persons
 * you can see" fell through to the model planner, which invented an action (opened the
 * Generate Studio) and, offline, looped "Sorry — I didn't catch an edit in that…" at a user
 * who was only asking a question.
 *
 * Precision-first, both directions:
 *  - a prompt is only a QUESTION here when it carries an interrogative lead/shape AND no
 *    edit verb — "can you make it brighter?" contains "make" → still an edit ask;
 *  - missing a question is safe (old behavior: model tier decides); wrongly swallowing an
 *    edit is not — so the edit-verb list wins every tie.
 *
 * Pure module (node-safe) — covered by brain:eval.
 */

const INTERROGATIVE_LEAD_RE =
  /^(?:(?:hey |ok |okay |please |so )*)(?:how|what|whats|what's|why|when|where|which|who|whose|is there|are there|is it|are they|do you|does|did you|can you see|can you tell|could you tell|tell me|give me|how many|how much|how long|am i)\b/;

/** Interrogative anywhere after an "analyze…" style lead — "analyze clip 5 and tell me how many…". */
const EMBEDDED_QUESTION_RE = /\b(?:tell me|how many|how much|what is|what's|give me (?:a |the )?(?:number|count|summary|answer))\b/;

/**
 * Verbs that make a prompt an EDIT ask no matter how it's phrased. Deliberately broad —
 * any hit sends the prompt down the normal edit path (the safe direction).
 */
const EDIT_VERB_RE =
  /\b(?:mak|add|remov|delet|apply|appli|chang|sett|set|mov|putt|put|cutt|cut|splitt|split|trimm|trim|blurr|blur|sharpen|soften|brighten|darken|fad|fade|zoom|rotat|resiz|cropp|crop|scal|grad|animat|keyfram|caption|subtitl|render|export|undo|redo|revers|mut|unmut|extract|replac|swapp|swap|duplicat|nest|group|align|dropp|drop|insert|attach|detach|enabl|disabl|adjust|fix|clean|stabiliz|denois|upscal|generat|creat|build|edit)(?:e|es|ed|ing|s)?\b|\b(?:speed(?:ing)? up|slow(?:ing)? down|turn(?:ing)? (?:on|off))\b/;

/**
 * True when the prompt is a pure question (wants an ANSWER, not a timeline mutation).
 * Callers route these to the consultant/world answer paths and never build a plan.
 */
export function isQuestionNotEdit(prompt: string): boolean {
  const text = prompt.trim().toLowerCase();
  if (!text) {
    return false;
  }
  if (EDIT_VERB_RE.test(text)) {
    return false;
  }
  return INTERROGATIVE_LEAD_RE.test(text) || EMBEDDED_QUESTION_RE.test(text) || text.endsWith("?");
}
