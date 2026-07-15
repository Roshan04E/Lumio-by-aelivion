import { moduleTypes, templateDefinitions, type AiPlan, type ModuleType } from "@kimera-by-aelivion/shared";
import { gatewayHasProvider, planWithGateway } from "./aiGateway.service";
import { aiLog } from "../lib/logger";

/**
 * Project planner for `/create` "Plan graph" (and any prompt-started project).
 *
 * Primary path: the real multi-provider LLM gateway (aiGateway.service) turns the
 * creator's prompt into an `AiPlan` (template + effects + concrete copy). When no
 * provider key is configured, the pool is exhausted, or the model returns unusable
 * JSON, it degrades to the DETERMINISTIC keyword planner below so the flow never
 * breaks. The deterministic planner is a real offline heuristic, not fake data.
 */

const templateSlugs = templateDefinitions.map((template) => template.slug);

// ---------------------------------------------------------------------------
// Real LLM path
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const templateList = templateDefinitions
    .map((template) => `- ${template.slug}: ${template.name} (modules: ${template.requiredModules.join(", ")})`)
    .join("\n");
  return [
    "You are Kimera's reel planner. Turn a creator's prompt into a starting plan for a short vertical video.",
    "",
    "Pick the SINGLE best-fitting template and use its exact slug from this list:",
    templateList,
    "",
    `Valid effect module types: ${moduleTypes.join(", ")}.`,
    "",
    "Respond with ONLY a JSON object (no prose, no code fence), exactly this shape:",
    '{"style": string, "language": "english"|"hindi"|"hinglish", "templateSlug": <one slug from the list>, "effects": ModuleType[], "editableFields": { [key: string]: string | number | boolean }}',
    "",
    "editableFields must hold concrete copy inferred from the prompt (hook text, main text, price, quote, speaker name, caption style, etc.). Keep values short. Match the language of the prompt.",
  ].join("\n");
}

/** Pull the first balanced JSON object out of a model reply (tolerates fences / stray prose). */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const body = (fenced ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : null;
}

function coerceLanguage(value: unknown): AiPlan["language"] {
  return value === "hindi" || value === "hinglish" ? value : "english";
}

function parsePlan(text: string): AiPlan | null {
  const jsonText = extractJson(text);
  if (!jsonText) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object") return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  // Must resolve to a real template, otherwise the plan is unusable downstream.
  if (typeof raw.templateSlug !== "string" || !templateSlugs.includes(raw.templateSlug)) {
    return null;
  }
  const templateSlug = raw.templateSlug;

  const effects = Array.isArray(raw.effects)
    ? raw.effects.filter((effect): effect is ModuleType => (moduleTypes as readonly string[]).includes(effect as string))
    : [];

  const editableFields: AiPlan["editableFields"] = {};
  if (raw.editableFields && typeof raw.editableFields === "object") {
    for (const [key, value] of Object.entries(raw.editableFields as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        editableFields[key] = value;
      }
    }
  }

  return {
    style: typeof raw.style === "string" && raw.style.trim() ? raw.style.trim() : "custom",
    language: coerceLanguage(raw.language),
    templateSlug,
    effects,
    editableFields,
  };
}

// ---------------------------------------------------------------------------
// Deterministic offline fallback (real heuristic; runs only without an LLM key)
// ---------------------------------------------------------------------------

const keywordPlans: Array<{
  keywords: string[];
  templateSlug: string;
  style: string;
  effects: ModuleType[];
  fields: AiPlan["editableFields"];
}> = [
  {
    keywords: ["crime", "scam", "fraud", "police", "otp"],
    templateSlug: "crime-scam-awareness-reel",
    style: "dark_crime",
    effects: ["PERSON_EXTRACTION", "TEXT_BEHIND_PERSON", "AUTO_CAPTIONS"],
    fields: {
      hookText: "Aapka phone bajta hai...",
      mainText: "Aur scammer police bankar daraata hai",
      captionStyle: "bold_yellow",
      musicMood: "tense"
    }
  },
  {
    keywords: ["product", "sale", "shop", "offer", "price"],
    templateSlug: "product-promo-reel",
    style: "product_promo",
    effects: ["MOTION_TEXT", "ZOOM_CUTS"],
    fields: {
      productName: "New Drop",
      priceText: "₹999",
      offerText: "Today only",
      brandColor: "#C9FF4A"
    }
  },
  {
    keywords: ["podcast", "interview", "speaker", "clip"],
    templateSlug: "podcast-clip-reel",
    style: "podcast_caption",
    effects: ["AUTO_CAPTIONS", "MOTION_TEXT"],
    fields: {
      speakerName: "Guest",
      captionStyle: "clean_white",
      highlightWords: "truth,focus,growth"
    }
  },
  {
    keywords: ["motivation", "success", "discipline", "mindset"],
    templateSlug: "motivational-reel",
    style: "motivational",
    effects: ["AUTO_CAPTIONS", "MOTION_TEXT", "ZOOM_CUTS"],
    fields: {
      quoteText: "Discipline creates freedom.",
      musicMood: "uplifting",
      captionStyle: "creator_pop"
    }
  },
  {
    keywords: ["skate", "sports", "action", "dance", "travel"],
    templateSlug: "smart-3d-follow-text-reel",
    style: "smart_3d_follow_text",
    effects: ["PERSON_EXTRACTION", "PERSON_TRACKING", "SMART_3D_FOLLOW_TEXT"],
    fields: {
      followText: "SKATE MODE",
      trackingStyle: "cinematic",
      depthStrength: 0.7,
      motionBlur: true
    }
  }
];

function deterministicPlan(prompt: string): AiPlan {
  const normalized = prompt.toLowerCase();
  const match = keywordPlans.find((plan) => plan.keywords.some((keyword) => normalized.includes(keyword)));
  const selected = match ?? keywordPlans[0]!;
  const language = normalized.includes("hindi") || normalized.includes("hinglish") ? "hinglish" : "english";

  return {
    style: selected.style,
    language,
    templateSlug: selected.templateSlug,
    effects: selected.effects,
    editableFields: selected.fields
  };
}

// ---------------------------------------------------------------------------

export async function planProjectFromPrompt(prompt: string): Promise<AiPlan> {
  if (gatewayHasProvider()) {
    try {
      const result = await planWithGateway(buildSystemPrompt(), prompt);
      const parsed = result?.text ? parsePlan(result.text) : null;
      if (parsed) {
        aiLog.debug(`planner: LLM plan via ${result!.providerId} → ${parsed.templateSlug}`);
        return parsed;
      }
      aiLog.warn("planner: LLM reply unusable — using deterministic fallback");
    } catch (error) {
      aiLog.warn(`planner: gateway error (${error instanceof Error ? error.message : String(error)}) — deterministic fallback`);
    }
  }
  return deterministicPlan(prompt);
}
