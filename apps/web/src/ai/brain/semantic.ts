/**
 * Lumio Brain — tier-2 Semantic layer (B3). Catches PARAPHRASES of commands the lower tiers
 * already know how to compile, for zero tokens:
 *
 *   1. Slot extraction: clip references, times, colors, and numbers are lifted out of the
 *      prompt, leaving an intent SKELETON ("soften clip 2" → "soften <target>").
 *   2. Phrase index: the skeleton is matched against curated exemplars — exact skeleton match
 *      first (free, no model), then local embeddings (MiniLM via @huggingface/transformers,
 *      lazy singleton like local-transcription.ts) for unseen near-paraphrases.
 *   3. Rewrite + re-route: a match only selects the INTENT. The skeleton's slots are poured
 *      into that intent's canonical phrasing and the result re-enters the tier-0/1 router,
 *      so every structural gate still applies — unique target resolution, layer-type gates,
 *      the action's own Zod schema. Semantic never invents params; it only translates verbs.
 *
 * Also home to the PLAN CACHE (v2, retargetable): normalized prompt → a previously applied,
 * validated plan. A replay fires only while every clip the plan REFERENCES is byte-identical
 * to when it worked (unrelated edits and playhead moves don't invalidate it); deictic prompts
 * ("blur it", "split here") additionally pin the exact selection + playhead. 👎 on the LLM
 * turn (or an immediate undo) forgets the plan — repeats cost nothing, and never guess.
 *
 * PRECISION CONTRACT (AI_ARCHITECTURE.md): high similarity threshold + margin over the
 * runner-up intent + identical slot arity, else silent escalation. Every match carries a
 * `t2.*` ruleId, so 👎 feedback can distrust a mapping per-user like any other rule.
 */

import type { TimelineComposition } from "@lumio-by-aelivion/shared";
import { getSkill, getSkillTaskKind } from "@lumio-by-aelivion/shared";
import { extractColor } from "../planner/entities";
import type { AiPlan } from "../types";
import { brainPlan, normalizePrompt, routePrompt, type BrainContext, type BrainRouteResult } from "./router";
import { isRuleTrusted } from "./feedback";
import type { RuleStepInput } from "./rules";

const ESCALATE: BrainRouteResult = { kind: "escalate" };

// ---------------------------------------------------------------------------
// Slot extraction — structural fragments leave the sentence before matching
// ---------------------------------------------------------------------------

export type SlotType = "target" | "time" | "color" | "n";

export interface Slot {
  type: SlotType;
  /** The original text, reinserted verbatim into the canonical rewrite. */
  text: string;
}

export interface PromptSkeleton {
  /** The prompt with slots replaced by placeholders ("soften <target>"). */
  skeleton: string;
  /** Slots in order of appearance. */
  slots: Slot[];
}

interface SpanMatch {
  start: number;
  end: number;
  type: SlotType;
  text: string;
}

const ORDINAL_WORDS = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth";

/** Clip references + resolvable deixis. Plain "this"/"that" are NOT slots (too promiscuous —
 * "mark this spot", "take that back" must keep their words). */
const TARGET_RE = new RegExp(
  String.raw`\b(?:(?:the|my) )?(?:clip|layer) ?(?:#|number )?\d{1,3}\b` +
    String.raw`|\b(?:(?:the|my) )?\d{1,3}(?:st|nd|rd|th) (?:clip|layer)\b` +
    String.raw`|\b(?:(?:the|my) )?(?:${ORDINAL_WORDS}) (?:clip|layer)\b` +
    String.raw`|\bthe selected (?:clip|layer)\b|\b(?:this|that) clip\b|\bit\b`,
  "g"
);

const TIME_RE = /\b\d{1,4}(?:\.\d+)?\s?(?:s|sec|secs|second|seconds)\b/g;

const HEX_RE = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/g;

const COLOR_MODIFIERS = new Set([
  "neutral",
  "warm",
  "cool",
  "dark",
  "light",
  "bright",
  "deep",
  "pale",
  "soft",
  "muted",
  "vivid",
  "rich"
]);

function collect(text: string, re: RegExp, type: SlotType, into: SpanMatch[]): void {
  re.lastIndex = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    into.push({ start: match.index, end: match.index + match[0].length, type, text: match[0] });
  }
}

/** Single color words (optionally led by a modifier: "dark red"). Word-scan because the color
 * vocabulary lives inside `extractColor`, not as an exported list. */
function collectColorWords(text: string, into: SpanMatch[]): void {
  const wordRe = /[a-z]+/g;
  for (let match = wordRe.exec(text); match; match = wordRe.exec(text)) {
    const word = match[0];
    if (COLOR_MODIFIERS.has(word) || !extractColor(word)) {
      continue;
    }
    let start = match.index;
    let slotText = word;
    // Fold a directly-preceding modifier into the slot ("dark red" is ONE color phrase).
    const before = text.slice(0, match.index).match(/([a-z]+) $/);
    if (before && COLOR_MODIFIERS.has(before[1]!)) {
      start = match.index - before[1]!.length - 1;
      slotText = `${before[1]} ${word}`;
    }
    into.push({ start, end: match.index + word.length, type: "color", text: slotText });
  }
}

const NUMBER_RE = /\b\d{1,4}(?:\.\d+)?\b/g;

/**
 * Lift structural fragments out of a NORMALIZED prompt. Priority on overlap:
 * target > time > color > number (so "clip 3"'s digit never becomes a bare number).
 */
export function extractSkeleton(normalized: string): PromptSkeleton {
  const spans: SpanMatch[] = [];
  collect(normalized, TARGET_RE, "target", spans);
  collect(normalized, TIME_RE, "time", spans);
  collect(normalized, HEX_RE, "color", spans);
  collectColorWords(normalized, spans);
  collect(normalized, NUMBER_RE, "n", spans);

  // Earlier-listed passes win overlaps; then keep spans left-to-right.
  const kept: SpanMatch[] = [];
  for (const span of spans) {
    if (!kept.some((other) => span.start < other.end && other.start < span.end)) {
      kept.push(span);
    }
  }
  kept.sort((a, b) => a.start - b.start);

  let skeleton = "";
  let cursor = 0;
  const slots: Slot[] = [];
  for (const span of kept) {
    skeleton += normalized.slice(cursor, span.start) + `<${span.type}>`;
    slots.push({ type: span.type, text: span.text });
    cursor = span.end;
  }
  skeleton += normalized.slice(cursor);
  return { skeleton: skeleton.replace(/\s+/g, " ").trim(), slots };
}

// ---------------------------------------------------------------------------
// Phrase index — curated paraphrase exemplars per intent
// ---------------------------------------------------------------------------

interface IntentEntry {
  /** Feedback/trust key ("t2.blur") — 👎 distrusts the MAPPING, per user. */
  ruleId: string;
  /** Skeletons that mean this intent. */
  exemplars: string[];
  /** Canonical phrasing the lower tiers compile; placeholders are refilled from the prompt. */
  canonical: string;
}

/**
 * Every canonical MUST be a phrasing tier 0/1 compiles today (verified in brain:eval) — the
 * semantic layer translates verbs, the structural gates downstream do the safety work.
 * Widening rule: never add an exemplar without a brain:eval case.
 */
const PHRASE_INDEX: IntentEntry[] = [
  {
    ruleId: "t2.blur",
    canonical: "blur <target>",
    exemplars: [
      "soften <target>",
      "make <target> blurry",
      "make <target> softer",
      "make <target> blurred",
      "add some blur to <target>",
      "blur out <target>",
      "smooth out <target>"
    ]
  },
  {
    ruleId: "t2.blur-amount",
    canonical: "set the blur on <target> to <n>",
    exemplars: ["make the blur on <target> <n>", "change <target> blur to <n>", "set <target> blur strength to <n>"]
  },
  {
    ruleId: "t2.delete",
    canonical: "delete <target>",
    exemplars: [
      "get rid of <target>",
      "take out <target>",
      "throw away <target>",
      "trash <target>",
      "i don't need <target>",
      "i don't want <target> anymore"
    ]
  },
  {
    ruleId: "t2.split",
    canonical: "split <target> at playhead",
    exemplars: [
      "chop <target> at the playhead",
      "slice <target> at the playhead",
      "cut <target> in half at the playhead",
      "chop <target> here",
      "split <target> here",
      "cut <target> here"
    ]
  },
  {
    ruleId: "t2.split-here",
    canonical: "split at playhead",
    exemplars: ["cut here", "chop here", "slice here", "split here", "make a cut here", "cut at the playhead"]
  },
  {
    ruleId: "t2.marker",
    canonical: "add a marker",
    exemplars: [
      "mark this spot",
      "mark this moment",
      "mark here",
      "put a marker here",
      "put a pin here",
      "drop a pin here",
      "bookmark this moment"
    ]
  },
  {
    ruleId: "t2.text-color",
    canonical: "set the color of <target> to <color>",
    exemplars: [
      "paint <target> <color>",
      "give <target> a <color> color",
      "color <target> in <color>",
      "switch <target> to <color>"
    ]
  },
  {
    ruleId: "t2.move-later",
    canonical: "move <target> <time> later",
    exemplars: ["nudge <target> <time> later", "slide <target> <time> right", "bump <target> <time> later"]
  },
  {
    ruleId: "t2.move-earlier",
    canonical: "move <target> <time> earlier",
    exemplars: ["nudge <target> <time> earlier", "slide <target> <time> left", "bump <target> <time> earlier"]
  },
  {
    ruleId: "t2.fade-in",
    canonical: "fade in <target>",
    exemplars: ["make <target> fade in", "have <target> fade in", "<target> should fade in"]
  },
  {
    ruleId: "t2.fade-out",
    canonical: "fade out <target>",
    exemplars: ["make <target> fade out", "have <target> fade out", "<target> should fade out"]
  },
  {
    ruleId: "t2.cmd-pause",
    canonical: "pause",
    exemplars: ["freeze playback", "stop the video", "halt playback"]
  },
  {
    ruleId: "t2.cmd-play",
    canonical: "play",
    exemplars: ["start the video", "run the video", "resume playback"]
  },
  {
    ruleId: "t2.cmd-quality-low",
    canonical: "quarter resolution",
    exemplars: ["lowest quality", "lowest resolution", "performance mode"]
  },
  {
    ruleId: "t2.cmd-quality-high",
    canonical: "full resolution",
    exemplars: ["best quality preview", "highest quality", "max quality"]
  },
  {
    ruleId: "t2.cmd-panel-media",
    canonical: "open media pool",
    exemplars: ["open the media browser", "show my imported files", "open the file bin"]
  },
  {
    ruleId: "t2.cmd-panel-inspector",
    canonical: "open inspector",
    exemplars: ["show clip properties", "open the properties panel", "show the clip settings panel"]
  },
  {
    ruleId: "t2.capabilities",
    canonical: "what are your capabilities",
    exemplars: [
      "tell me everything you can do",
      "what's in your toolbox",
      "give me a rundown of what you can do",
      "list everything you can do",
      "what features do you have",
      "what do you know how to do",
      "what all can you do for me"
    ]
  }
];

// ---------------------------------------------------------------------------
// Concept → recipe (B7). Named looks are DATA: an exact concept phrase compiles straight to
// the color-grade skill with a registered CreativeLook — the same editable-grade-stack step
// the LLM would emit, but deterministic, instant, and zero tokens. Exact phrases only (no
// embedding fuzz for creative asks); 👎-gated per recipe like every brain rule.
// ---------------------------------------------------------------------------

interface ConceptRecipe {
  ruleId: string;
  /** Exact normalized phrases — never widened without a brain:eval case. */
  phrases: string[];
  /** A real `CreativeLook` name from packages/shared/src/color/looks.ts. */
  look: string;
  summary: string;
}

const CONCEPT_RECIPES: ConceptRecipe[] = [
  {
    ruleId: "t2.look-cinematic",
    look: "Cinematic",
    phrases: [
      "make it cinematic",
      "make it look cinematic",
      "make this look cinematic",
      "apply a cinematic look",
      "apply a cinematic grade",
      "give it a cinematic look",
      "cinematic look",
      "cinematic grade"
    ],
    summary: "Apply the Cinematic look (full editable grade stack)"
  },
  {
    ruleId: "t2.look-teal-orange",
    look: "Teal & Orange",
    phrases: [
      "teal and orange",
      "make it teal and orange",
      "apply teal and orange",
      "apply a teal and orange look",
      "give it a teal and orange look",
      "teal and orange grade"
    ],
    summary: "Apply the Teal & Orange look (full editable grade stack)"
  },
  {
    ruleId: "t2.look-noir",
    look: "Noir",
    phrases: ["make it noir", "apply a noir look", "give it a noir look", "noir look", "noir grade"],
    summary: "Apply the Noir look (full editable grade stack)"
  }
];

function conceptRecipeResult(prompt: string, normalized: string): BrainRouteResult | null {
  const recipe = CONCEPT_RECIPES.find((entry) => entry.phrases.includes(normalized));
  if (!recipe || !isRuleTrusted(recipe.ruleId)) {
    return null;
  }
  // Same trust boundary as the LLM's skill steps: the task's own Zod schema validates the intent.
  const skill = getSkill("color-grade");
  const task = skill ? getSkillTaskKind(skill, "color-grade") : undefined;
  if (!skill || !task) {
    return null;
  }
  const parsed = task.inputSchema.safeParse({ look: recipe.look });
  if (!parsed.success) {
    return null;
  }
  const plan: AiPlan = {
    id: `plan_recipe_${Math.random().toString(36).slice(2, 10)}`,
    prompt,
    steps: [
      {
        id: `recipe_${Math.random().toString(36).slice(2, 8)}`,
        kind: "skill",
        skillId: skill.id,
        taskKind: task.id,
        params: parsed.data,
        summary: recipe.summary,
        cost: { tier: "browser", credits: 0 }
      }
    ],
    totalCredits: 0,
    confidence: "Exact",
    notes: [],
    provider: "brain"
  };
  return { kind: "plan", plan, tier: "semantic", ruleId: recipe.ruleId };
}

function placeholders(template: string): SlotType[] {
  return [...template.matchAll(/<(target|time|color|n)>/g)].map((match) => match[1] as SlotType);
}

function sameSlotArity(a: SlotType[], b: SlotType[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const counts = new Map<SlotType, number>();
  for (const type of a) {
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  for (const type of b) {
    const left = (counts.get(type) ?? 0) - 1;
    if (left < 0) {
      return false;
    }
    counts.set(type, left);
  }
  return true;
}

/** Pour the prompt's slots into the canonical phrasing (slots consumed per-type, in order). */
function rewrite(canonical: string, slots: Slot[]): string | null {
  const pool = [...slots];
  let failed = false;
  const rewritten = canonical.replace(/<(target|time|color|n)>/g, (_all, type: string) => {
    const index = pool.findIndex((slot) => slot.type === type);
    if (index < 0) {
      failed = true;
      return "";
    }
    return pool.splice(index, 1)[0]!.text;
  });
  return failed || pool.length > 0 ? null : rewritten;
}

// ---------------------------------------------------------------------------
// Embeddings — lazy MiniLM singleton (the local-transcription.ts pattern)
// ---------------------------------------------------------------------------

export type SemanticEmbedder = (texts: string[]) => Promise<number[][]>;

/** Cosine threshold + required margin over the best OTHER intent. Deliberately strict —
 * a missed paraphrase costs one LLM call; a wrong fire costs trust. */
const SIMILARITY_THRESHOLD = 0.9;
const SIMILARITY_MARGIN = 0.04;

const transformersUrls = [
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2",
  "https://esm.sh/@huggingface/transformers@3.7.2"
];

type FeaturePipeline = (input: string[], options?: Record<string, unknown>) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

let testEmbedder: SemanticEmbedder | null = null;
let embedderLoad: Promise<SemanticEmbedder | null> | null = null;
let readyEmbedder: SemanticEmbedder | null = null;
let exemplarVectors: Map<string, number[]> | null = null;
let exemplarVectorsLoad: Promise<void> | null = null;

/** Eval/test hook: inject a deterministic embedder (null restores the real lazy model). */
export function __setSemanticEmbedderForTests(embedder: SemanticEmbedder | null): void {
  testEmbedder = embedder;
  readyEmbedder = null;
  embedderLoad = null;
  exemplarVectors = null;
  exemplarVectorsLoad = null;
}

async function loadRealEmbedder(): Promise<SemanticEmbedder | null> {
  let lastError: unknown;
  for (const url of transformersUrls) {
    try {
      const mod = (await import(/* @vite-ignore */ url)) as {
        pipeline?: (task: string, model: string, options?: Record<string, unknown>) => Promise<FeaturePipeline>;
      };
      if (!mod.pipeline) {
        continue;
      }
      const extractor = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      return async (texts: string[]) => {
        const output = await extractor(texts, { pooling: "mean", normalize: true });
        const dim = output.dims[output.dims.length - 1] ?? 384;
        const rows: number[][] = [];
        for (let row = 0; row < texts.length; row += 1) {
          rows.push(Array.from({ length: dim }, (_, col) => Number(output.data[row * dim + col])));
        }
        return rows;
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    // Embeddings are an enhancement — the exact-skeleton path keeps working without them.
    console.warn("Lumio Brain: local embedding model unavailable; tier-2 stays on exact matching.", lastError);
  }
  return null;
}

/**
 * Non-blocking readiness: the first semantic miss kicks off the (one-time, ~25 MB) model load
 * in the background and escalates immediately — the user never waits on a download. Once warm,
 * matches cost one <50 ms embed call. In node (brain:eval) the real model never loads; tests
 * inject an embedder instead.
 */
function embedderIfReady(): SemanticEmbedder | null {
  if (testEmbedder) {
    readyEmbedder = testEmbedder;
  }
  if (readyEmbedder) {
    return readyEmbedder;
  }
  if (!embedderLoad && typeof window !== "undefined") {
    embedderLoad = loadRealEmbedder().then((embedder) => {
      readyEmbedder = embedder;
      return embedder;
    });
  }
  return null;
}

async function ensureExemplarVectors(embed: SemanticEmbedder): Promise<Map<string, number[]>> {
  if (exemplarVectors) {
    return exemplarVectors;
  }
  exemplarVectorsLoad ??= (async () => {
    const skeletons = PHRASE_INDEX.flatMap((entry) => entry.exemplars);
    const vectors = await embed(skeletons);
    const map = new Map<string, number[]>();
    skeletons.forEach((skeleton, index) => map.set(skeleton, vectors[index]!));
    exemplarVectors = map;
  })();
  await exemplarVectorsLoad;
  return exemplarVectors!;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}

// ---------------------------------------------------------------------------
// Learned phrases — the B6 write path lands here; the read path is live now
// ---------------------------------------------------------------------------

interface LearnedPhrase {
  skeleton: string;
  /** ruleId of the PHRASE_INDEX intent this skeleton maps to. */
  ruleId: string;
  at: number;
}

const PHRASES_KEY = "lumio.brain.phrases.v1";
const MAX_PHRASES = 200;

let memoryPhrases: LearnedPhrase[] = [];

function loadPhrases(): LearnedPhrase[] {
  try {
    if (typeof localStorage !== "undefined") {
      const parsed: unknown = JSON.parse(localStorage.getItem(PHRASES_KEY) ?? "[]");
      return Array.isArray(parsed) ? (parsed as LearnedPhrase[]) : [];
    }
  } catch {
    // fall through
  }
  return memoryPhrases;
}

function savePhrases(phrases: LearnedPhrase[]): void {
  const bounded = phrases.slice(-MAX_PHRASES);
  memoryPhrases = bounded;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PHRASES_KEY, JSON.stringify(bounded));
    }
  } catch {
    // best-effort
  }
}

/** Teach the semantic layer that `skeleton` means an existing intent (B6 write path — called
 * when the LLM resolves a phrase tier 2 missed). Idempotent per skeleton. */
export function learnPhrase(skeleton: string, ruleId: string): void {
  if (!PHRASE_INDEX.some((entry) => entry.ruleId === ruleId)) {
    return;
  }
  const phrases = loadPhrases().filter((phrase) => phrase.skeleton !== skeleton);
  phrases.push({ skeleton, ruleId, at: Date.now() });
  savePhrases(phrases);
}

function learnedIntentFor(skeleton: string): IntentEntry | undefined {
  const learned = loadPhrases().find((phrase) => phrase.skeleton === skeleton);
  return learned ? PHRASE_INDEX.find((entry) => entry.ruleId === learned.ruleId) : undefined;
}

/** Map ONE executed step to the phrase-index intent it expresses, or null. */
function intentForStep(step: RuleStepInput): IntentEntry | undefined {
  const params = (step.params ?? {}) as Record<string, unknown>;
  const find = (ruleId: string) => PHRASE_INDEX.find((entry) => entry.ruleId === ruleId);
  switch (step.actionId) {
    case "addEffect":
      return params.effectType === "blur" ? find("t2.blur") : undefined;
    case "deleteLayer":
      return find("t2.delete");
    case "splitClip":
      return find("t2.split");
    case "addMarker":
      return find("t2.marker");
    case "updateText": {
      const keys = Object.keys(params).filter((key) => key !== "layerId");
      return keys.length === 1 && keys[0] === "color" ? find("t2.text-color") : undefined;
    }
    case "moveLayer":
      if (typeof params.deltaSeconds === "number" && params.deltaSeconds !== 0) {
        return find(params.deltaSeconds > 0 ? "t2.move-later" : "t2.move-earlier");
      }
      return undefined;
    case "addTransition":
      if (params.kind === "fadeIn") return find("t2.fade-in");
      if (params.kind === "fadeOut") return find("t2.fade-out");
      return undefined;
    default:
      return undefined;
  }
}

/**
 * B6 learning write path — called after the LLM successfully resolves a prompt the local tiers
 * missed. If the run was ONE plain action whose intent the phrase index knows, teach the
 * prompt's SKELETON as a new exemplar: the next time this user phrases it that way (with ANY
 * clip/color/time), tier 2 compiles it locally for free. Precision gates: the skeleton's slots
 * must exactly fit the intent's canonical template (a prompt whose target didn't extract as a
 * slot is NOT generalizable and is never learned), and the skeleton must be short.
 */
export function maybeLearnPhrase(prompt: string, steps: RuleStepInput[]): void {
  if (steps.length !== 1) {
    return;
  }
  const entry = intentForStep(steps[0]!);
  if (!entry) {
    return;
  }
  const normalized = normalizePrompt(prompt);
  const { skeleton, slots } = extractSkeleton(normalized);
  if (skeleton.length > 60 || entry.exemplars.includes(skeleton)) {
    return;
  }
  if (!sameSlotArity(placeholders(entry.canonical), slots.map((slot) => slot.type))) {
    return;
  }
  learnPhrase(skeleton, entry.ruleId);
}

// ---------------------------------------------------------------------------
// Plan cache — repeats of validated plans are free (v2: retargetable)
// ---------------------------------------------------------------------------

export interface PlanCacheContext {
  composition: TimelineComposition;
  selection: string[];
  nowSeconds: number;
}

interface CachedPlan {
  /** Normalized prompt — one cached plan per phrasing (latest wins). */
  promptKey: string;
  steps: RuleStepInput[];
  /** The layer ids the steps actually reference — the replay-validity surface. */
  layerIds: string[];
  /** djb2 over those layers' JSON at store time. */
  layersHash: string;
  /** Set for deictic prompts ("it", "here"…): replay also needs this exact selection+playhead. */
  exact: { selection: string[]; nowMs: number } | null;
  at: number;
}

const PLAN_CACHE_KEY = "lumio.brain.plancache.v2";
const MAX_CACHED_PLANS = 50;

function djb2(payload: string): string {
  let hash = 5381;
  for (let index = 0; index < payload.length; index += 1) {
    hash = ((hash << 5) + hash + payload.charCodeAt(index)) | 0;
  }
  return `${payload.length}:${hash}`;
}

/** A prompt whose meaning depends on editor state (selection/playhead), not just its words —
 * such plans only replay against the EXACT state they were validated in. Explicitly-targeted
 * prompts ("blur clip 2") instead replay whenever their referenced clips are unchanged. */
const DEIXIS_RE = /\b(it|this|that|these|those|selected|selection|here|playhead|now|current)\b/;

function referencedLayerIds(steps: RuleStepInput[], composition: TimelineComposition): string[] {
  const known = new Set(composition.tracks.flatMap((track) => track.layers.map((entry) => entry.id)));
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (known.has(value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  for (const step of steps) {
    walk(step.params);
  }
  return [...found].sort();
}

/** Hash of exactly the referenced layers' current state; null when any of them is gone. */
function layersHash(composition: TimelineComposition, layerIds: string[]): string | null {
  const byId = new Map(composition.tracks.flatMap((track) => track.layers.map((entry) => [entry.id, entry] as const)));
  const parts: string[] = [];
  for (const id of layerIds) {
    const found = byId.get(id);
    if (!found) {
      return null;
    }
    parts.push(JSON.stringify(found));
  }
  return djb2(parts.join(" "));
}

function loadPlanCache(): CachedPlan[] {
  try {
    if (typeof localStorage !== "undefined") {
      const parsed: unknown = JSON.parse(localStorage.getItem(PLAN_CACHE_KEY) ?? "[]");
      return Array.isArray(parsed) ? (parsed as CachedPlan[]) : [];
    }
  } catch {
    // fall through
  }
  return memoryPlanCache;
}

let memoryPlanCache: CachedPlan[] = [];

function savePlanCache(cache: CachedPlan[]): void {
  const bounded = cache.slice(-MAX_CACHED_PLANS);
  memoryPlanCache = bounded;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify(bounded));
    }
  } catch {
    // best-effort
  }
}

/** Store an APPLIED, all-timelineAction plan against the pre-run context. */
export function storeCachedPlan(prompt: string, context: PlanCacheContext, steps: RuleStepInput[]): void {
  if (steps.length === 0 || steps.length > 8) {
    return;
  }
  const promptKey = normalizePrompt(prompt);
  const layerIds = referencedLayerIds(steps, context.composition);
  const hash = layersHash(context.composition, layerIds);
  if (!promptKey || hash === null) {
    return;
  }
  const exact = DEIXIS_RE.test(promptKey)
    ? { selection: [...context.selection].sort(), nowMs: Math.round(context.nowSeconds * 1000) }
    : null;
  const cache = loadPlanCache().filter((entry) => entry.promptKey !== promptKey);
  cache.push({ promptKey, steps, layerIds, layersHash: hash, exact, at: Date.now() });
  savePlanCache(cache);
}

function lookupCachedPlan(prompt: string, context: PlanCacheContext): RuleStepInput[] | undefined {
  const promptKey = normalizePrompt(prompt);
  const entry = loadPlanCache().find((candidate) => candidate.promptKey === promptKey);
  if (!entry) {
    return undefined;
  }
  // Every clip the plan touches must be EXACTLY as it was — a moved/retrimmed/deleted target
  // means the stored step params may no longer say what the user means (never wrong-target).
  if (layersHash(context.composition, entry.layerIds) !== entry.layersHash) {
    return undefined;
  }
  if (entry.exact) {
    if (Math.round(context.nowSeconds * 1000) !== entry.exact.nowMs) {
      return undefined;
    }
    const selection = [...context.selection].sort();
    if (selection.length !== entry.exact.selection.length || selection.some((id, index) => id !== entry.exact!.selection[index])) {
      return undefined;
    }
  }
  return entry.steps;
}

/** 👎 on an LLM turn (or an undo right after it): this prompt's cached plan AND any phrase
 * learned from it are wrong for this user — drop both so it goes back to the model next time. */
export function forgetLearnedPlan(prompt: string): void {
  const promptKey = normalizePrompt(prompt);
  savePlanCache(loadPlanCache().filter((entry) => entry.promptKey !== promptKey));
  const { skeleton } = extractSkeleton(promptKey);
  savePhrases(loadPhrases().filter((phrase) => phrase.skeleton !== skeleton));
}

export function clearSemanticStores(): void {
  memoryPlanCache = [];
  memoryPhrases = [];
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(PLAN_CACHE_KEY);
      localStorage.removeItem(PHRASES_KEY);
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// The tier-2 route
// ---------------------------------------------------------------------------

function routeThroughIntent(entry: IntentEntry, slots: Slot[], prompt: string, context: BrainContext): BrainRouteResult {
  if (!isRuleTrusted(entry.ruleId)) {
    return ESCALATE;
  }
  const rewritten = rewrite(entry.canonical, slots);
  if (!rewritten) {
    return ESCALATE;
  }
  const inner = routePrompt(rewritten, context);
  // Only plan/answer/command results pass through — and they keep the ORIGINAL prompt plus the
  // t2 ruleId, so feedback trains the paraphrase mapping (the risky part), not the inner rule.
  if (inner.kind === "plan") {
    return { kind: "plan", plan: { ...inner.plan, prompt }, tier: "semantic", ruleId: entry.ruleId };
  }
  if (inner.kind === "answer") {
    return { kind: "answer", text: inner.text, tier: "semantic", ruleId: entry.ruleId };
  }
  if (inner.kind === "command") {
    return { ...inner, ruleId: entry.ruleId };
  }
  return ESCALATE;
}

/**
 * Tier 2 — called by the panel ONLY after `routePrompt` escalated. Async because the embed is,
 * but never slow: exact skeleton/plan-cache hits are string lookups, and when the model isn't
 * loaded yet it escalates immediately (kicking the download off in the background).
 */
export async function routePromptSemantic(prompt: string, context: BrainContext): Promise<BrainRouteResult> {
  const normalized = normalizePrompt(prompt);
  if (!normalized || normalized.length > 160) {
    return ESCALATE;
  }

  // Plan cache: exact prompt against an exactly-matching timeline → replay (Zod re-validated).
  const cachedSteps = lookupCachedPlan(prompt, context);
  if (cachedSteps && isRuleTrusted("t2.plan-cache")) {
    const plan = brainPlan(prompt, cachedSteps);
    if (plan) {
      return { kind: "plan", plan, tier: "semantic", ruleId: "t2.plan-cache" };
    }
  }

  // Concept → recipe (B7): exact-phrase named looks compile to the color-grade skill.
  const recipe = conceptRecipeResult(prompt, normalized);
  if (recipe) {
    return recipe;
  }

  const { skeleton, slots } = extractSkeleton(normalized);

  // Exact skeleton match — curated exemplars + learned phrases, no model required.
  for (const entry of PHRASE_INDEX) {
    if (entry.exemplars.includes(skeleton) && sameSlotArity(placeholders(entry.canonical), slots.map((slot) => slot.type))) {
      const result = routeThroughIntent(entry, slots, prompt, context);
      if (result.kind !== "escalate") {
        return result;
      }
    }
  }
  const learned = learnedIntentFor(skeleton);
  if (learned && sameSlotArity(placeholders(learned.canonical), slots.map((slot) => slot.type))) {
    const result = routeThroughIntent(learned, slots, prompt, context);
    if (result.kind !== "escalate") {
      return result;
    }
  }

  // Embedding match — unseen paraphrases, once the model is warm.
  const embed = embedderIfReady();
  if (!embed) {
    return ESCALATE;
  }
  try {
    const vectors = await ensureExemplarVectors(embed);
    const [candidate] = await embed([skeleton]);
    if (!candidate) {
      return ESCALATE;
    }
    // Per-intent max similarity, then require the best ARITY-COMPATIBLE intent to clear the
    // threshold AND beat every other intent by the margin (confusable verbs must escalate).
    const slotTypes = slots.map((slot) => slot.type);
    const perIntent = PHRASE_INDEX.map((entry) => ({
      entry,
      compatible: sameSlotArity(placeholders(entry.canonical), slotTypes),
      score: Math.max(...entry.exemplars.map((exemplar) => {
        const vector = vectors.get(exemplar);
        return vector ? cosine(candidate, vector) : 0;
      }))
    }));
    const best = perIntent.filter((item) => item.compatible).sort((a, b) => b.score - a.score)[0];
    const bestOther = Math.max(0, ...perIntent.filter((item) => item.entry !== best?.entry).map((item) => item.score));
    if (!best || best.score < SIMILARITY_THRESHOLD || best.score - bestOther < SIMILARITY_MARGIN) {
      return ESCALATE;
    }
    return routeThroughIntent(best.entry, slots, prompt, context);
  } catch {
    return ESCALATE;
  }
}
