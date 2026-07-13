import type { AiPlan, ModuleType } from "@kimera-by-aelivion/shared";

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

export function planProjectFromPrompt(prompt: string): AiPlan {
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
