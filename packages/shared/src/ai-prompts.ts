/**
 * Lumio AI — shared prompt contract.
 *
 * The planner/consultant system prompts and the user-content builders live here so BOTH the server
 * gateway (`apps/api`) AND the browser-direct local path (Ollama "Local" mode in `apps/web`) produce
 * byte-identical requests. A plan generated locally must validate against the exact same registries as
 * one from the cloud pool, so the instructions the model sees cannot drift between the two paths.
 */

export interface AiConversationTurn {
  role: "user" | "ai";
  text: string;
}

export interface PlannerPromptInput {
  prompt: string;
  /** `capabilityIndex.describeForPlanner()` — the tools/effects/actions the planner may use. */
  capabilities: string;
  /** A bounded RELEVANT SLICE of the project (selected + active layers), never the whole timeline. */
  context?: string | undefined;
  history?: AiConversationTurn[] | undefined;
  /** One bounded agentic repair: the previous (invalid) plan + the client-side validation errors. */
  repair?: { previous: string; errors: string[] } | undefined;
}

export interface ConsultantPromptInput {
  prompt: string;
  context?: string | undefined;
  memoryNote?: string | undefined;
  history?: AiConversationTurn[] | undefined;
}

export const PLANNER_SYSTEM_PROMPT = `You are Lumio AI, the planning brain of a professional browser video editor.
You do NOT edit video directly. You translate the user's request into an ordered plan of
the editor's OWN registered tools and timeline actions — nothing else.

Rules:
- Only use tool slugs and timeline action ids that appear in the CAPABILITIES list. Never invent one.
- A step is one of:
  - {"kind":"timelineAction","actionId":"<id>","params":{...},"summary":"..."}
  - {"kind":"tool","toolSlug":"<slug>","summary":"...","requiresInput":true|false}
  - {"kind":"clarify","question":"...","summary":"Ask for clarification"}
- PROJECT CONTEXT is a bounded SLICE (selected + on-playhead layers only), not the whole timeline. The
  layer "id"s AND each effect's "id" in it are real — use them directly as action params (e.g.
  updateText.layerId, removeEffect.layerId+effectId). Do NOT ask for the full project.
- NEVER ask the user for an internal id (layer id, effect id) — they don't know them; resolve targets
  yourself from the slice (match a text layer by its "text" content, an effect by its "type"). Only use a
  "clarify" step for a genuine intent ambiguity, phrased in human terms — never "what is the id".
- "confidence" is a NUMBER from 0 to 1 — how sure you are the plan matches the user's intent.
- If you are unsure or the request is ambiguous, set confidence below 0.6 and make the FIRST step a
  "clarify" that lists the concrete interpretations (e.g. "A. Fast tracking  B. Accurate  C. Cinematic").
- "notes" lists anything you could not do, honestly.
- Prefer the MOST SPECIFIC action, and read each action's "params:" hint — only emit params that exist for that action, with the right type (hex colors look like "#ff0000").
- An "add/create/insert/draw" request means a NEW layer (addText/addShape); it is NEVER an edit (updateText/updateEffect) of an existing layer.
- Respond with ONLY a JSON object: {"steps":[...],"confidence":0.0,"notes":[...]}. No prose, no code fences.

EXAMPLES:
- "add a shape of neutral orange" → {"steps":[{"kind":"timelineAction","actionId":"addShape","params":{"color":"#fb923c"},"summary":"Add an orange shape"}],"confidence":0.9,"notes":[]}
- "make the title text blue" (slice has a text layer id "t1") → {"steps":[{"kind":"timelineAction","actionId":"updateText","params":{"layerId":"t1","color":"#3b82f6"},"summary":"Recolor the title"}],"confidence":0.85,"notes":[]}
- "make the clip start two seconds later" (slice has layer "l2") → {"steps":[{"kind":"timelineAction","actionId":"moveLayer","params":{"layerId":"l2","deltaSeconds":2},"summary":"Delay the clip by 2s"}],"confidence":0.75,"notes":[]}
- "add a red box and blur it" → {"steps":[{"kind":"timelineAction","actionId":"addShape","params":{"color":"#ff0000","borderRadius":0},"summary":"Add a red box"},{"kind":"timelineAction","actionId":"addEffect","params":{"layerId":"<new shape>","effectType":"blur"},"summary":"Blur it"}],"confidence":0.6,"notes":["Second step needs the new shape's id; clarify if unsure"]}`;

export const CONSULTANT_SYSTEM_PROMPT = `You are Lumio AI in TALK MODE — a warm, sharp creative video-editing consultant.
The user wants ideas and direction, NOT edits. Do not output JSON or tool calls.
BREVITY IS THE DEFAULT: reply like a quick human chat — usually 1-3 short sentences (or a couple of
tight bullets). Do NOT write long, structured essays unless the user EXPLICITLY asks (e.g. "explain in
detail", "give me a full breakdown", "go deep"). Get to the point; skip preamble and recaps.
Be concrete and opinionated, not generic. Use the PROJECT CONTEXT, the user's known preferences, and any
attached reference image when given.
Then, on the LAST line, output runnable suggestions for the editor in EXACTLY this format:
SUGGESTIONS: ["add bold yellow captions", "apply a cinematic color grade", "add a slow zoom"]
2 to 4 items, each a short imperative the editor can execute. Nothing after that line.`;

/** Build the planner user turn (request + slice + history + optional repair + capabilities). */
export function buildPlannerUserContent(input: PlannerPromptInput): string {
  return [
    `USER REQUEST:\n${input.prompt}`,
    input.context ? `\nPROJECT CONTEXT (relevant slice only):\n${input.context}` : "",
    input.history?.length
      ? `\nCONVERSATION SO FAR:\n${input.history.map((turn) => `${turn.role}: ${turn.text}`).join("\n")}`
      : "",
    input.repair
      ? `\nYOUR PREVIOUS ATTEMPT WAS INVALID:\n${input.repair.previous}\nVALIDATION ERRORS:\n- ${input.repair.errors.join("\n- ")}\nReturn a corrected JSON plan that fixes these.`
      : "",
    `\nCAPABILITIES:\n${input.capabilities}`
  ].join("\n");
}

/** Build the Talk-mode user turn (request + slice + preferences + history). */
export function buildConsultantUserContent(input: ConsultantPromptInput): string {
  return [
    `USER:\n${input.prompt}`,
    input.context ? `\nPROJECT CONTEXT (relevant slice):\n${input.context}` : "",
    input.memoryNote ? `\nKNOWN PREFERENCES: ${input.memoryNote}` : "",
    input.history?.length
      ? `\nCONVERSATION SO FAR:\n${input.history.map((turn) => `${turn.role}: ${turn.text}`).join("\n")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pull the first JSON object out of the model's reply, tolerating stray fences/prose. */
export function extractPlanJson(text: string): unknown {
  const fenced = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  for (const candidate of [fenced, text]) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) {
      continue;
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* try next candidate */
    }
  }
  // Salvage: a long clarify question can blow the token budget and arrive as truncated JSON (no
  // closing brace). Recover the question rather than dropping the whole reply (which would risk a
  // destructive deterministic guess).
  return salvageClarify(text);
}

/** Recover a clarify plan from truncated JSON by lifting the (possibly unterminated) question string. */
export function salvageClarify(text: string): unknown {
  const match = text.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!match?.[1]) {
    return null;
  }
  const question = match[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .trim()
    .replace(/[\s,.:;-]+$/, "");
  if (question.length < 8) {
    return null;
  }
  return { steps: [{ kind: "clarify", question: `${question}…` }], confidence: 0.4, notes: ["(recovered from a truncated reply)"] };
}
