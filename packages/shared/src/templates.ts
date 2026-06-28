import { createTemplateEffect } from "./dependencies";
import type { EditableFieldDefinition, ModuleType, ProjectGraph, TemplateDefinition } from "./types";

const assetUrl = (slug: string) => `/assets/template-${slug}.jpg`;

function fields(definitions: EditableFieldDefinition[]): EditableFieldDefinition[] {
  return definitions;
}

function templateGraph(slug: string, requiredModules: ModuleType[], editableFields: EditableFieldDefinition[]): ProjectGraph {
  return {
    projectId: `template_${slug}`,
    effects: requiredModules.map((moduleType, index) => createTemplateEffect(slug, moduleType, index)),
    editableFields: Object.fromEntries(editableFields.map((field) => [field.key, field.defaultValue])),
    version: 1
  };
}

function buildTemplate(input: Omit<TemplateDefinition, "id" | "previewUrl" | "thumbnailUrl" | "templateGraph" | "active">): TemplateDefinition {
  return {
    id: `template_${input.slug}`,
    previewUrl: assetUrl(input.slug),
    thumbnailUrl: assetUrl(input.slug),
    templateGraph: templateGraph(input.slug, input.requiredModules, input.editableFields),
    active: true,
    ...input
  };
}

export const templateDefinitions: TemplateDefinition[] = [
  buildTemplate({
    name: "Text Behind Person Reel",
    slug: "text-behind-person-reel",
    category: "Cinematic",
    description: "Large masked title text behind a moving subject with subtle depth.",
    durationSeconds: 12,
    requiredModules: ["PERSON_EXTRACTION", "TEXT_BEHIND_PERSON", "MOTION_TEXT", "FINAL_RENDER"],
    editableFields: fields([
      { key: "mainText", label: "Main text", type: "text", defaultValue: "MAIN CHARACTER" },
      { key: "fontStyle", label: "Font style", type: "select", defaultValue: "condensed", options: ["condensed", "bold", "minimal"] },
      { key: "textPosition", label: "Text position", type: "select", defaultValue: "behind_person", options: ["behind_person", "center", "top"] },
      { key: "textColor", label: "Text color", type: "color", defaultValue: "#C9FF4A" },
      { key: "depthFeel", label: "Depth feel", type: "number", defaultValue: 0.7 }
    ]),
    creditCost: 18
  }),
  buildTemplate({
    name: "Smart 3D Follow Text Reel",
    slug: "smart-3d-follow-text-reel",
    category: "Motion",
    description: "Subject-aware follow text with tracked scale, depth, and motion blur.",
    durationSeconds: 13,
    requiredModules: ["PERSON_EXTRACTION", "PERSON_TRACKING", "SMART_3D_FOLLOW_TEXT", "FINAL_RENDER"],
    editableFields: fields([
      { key: "followText", label: "Follow text", type: "text", defaultValue: "SKATE MODE" },
      { key: "trackingStyle", label: "Tracking style", type: "select", defaultValue: "cinematic", options: ["locked", "cinematic", "snappy"] },
      { key: "depthStrength", label: "Depth strength", type: "number", defaultValue: 0.7 },
      { key: "shadow", label: "Shadow", type: "boolean", defaultValue: true },
      { key: "motionBlur", label: "Motion blur", type: "boolean", defaultValue: true }
    ]),
    creditCost: 17
  }),
  buildTemplate({
    name: "Viral Hindi Caption Reel",
    slug: "viral-hindi-caption-reel",
    category: "Captions",
    description: "Bold Hinglish captions, punch words, and quick zoom resets.",
    durationSeconds: 15,
    requiredModules: ["AUTO_CAPTIONS", "MOTION_TEXT", "ZOOM_CUTS", "FINAL_RENDER"],
    editableFields: fields([
      { key: "captionLanguage", label: "Caption language", type: "select", defaultValue: "hinglish", options: ["hindi", "hinglish"] },
      { key: "captionStyle", label: "Caption style", type: "select", defaultValue: "bold_yellow", options: ["bold_yellow", "creator_pop", "clean_white"] },
      { key: "punchWords", label: "Punch words", type: "text", defaultValue: "sach,wait,proof" },
      { key: "zoomIntensity", label: "Zoom intensity", type: "select", defaultValue: "viral", options: ["soft", "medium", "viral"] }
    ]),
    creditCost: 19
  }),
  buildTemplate({
    name: "Crime / Scam Awareness Reel",
    slug: "crime-scam-awareness-reel",
    category: "Awareness",
    description: "Dark warning captions, evidence-board background, and urgent motion titles.",
    durationSeconds: 15,
    requiredModules: ["AUTO_CAPTIONS", "MOTION_TEXT", "BACKGROUND_REPLACEMENT", "FINAL_RENDER"],
    editableFields: fields([
      { key: "hookText", label: "Hook text", type: "text", defaultValue: "Aapka phone bajta hai..." },
      { key: "warningText", label: "Warning text", type: "text", defaultValue: "Bank OTP kabhi share mat karo" },
      { key: "mood", label: "Mood", type: "select", defaultValue: "tense", options: ["tense", "documentary", "urgent"] },
      { key: "evidenceBoardStyle", label: "Evidence board", type: "select", defaultValue: "red-thread", options: ["red-thread", "paper-wall", "cyber-grid"] }
    ]),
    creditCost: 21
  }),
  buildTemplate({
    name: "Product Promo Reel",
    slug: "product-promo-reel",
    category: "Commerce",
    description: "Fast product hook, price reveal, offer text, and zoom emphasis.",
    durationSeconds: 12,
    requiredModules: ["MOTION_TEXT", "ZOOM_CUTS", "FINAL_RENDER"],
    editableFields: fields([
      { key: "productName", label: "Product name", type: "text", defaultValue: "Wireless Mic" },
      { key: "priceText", label: "Price text", type: "text", defaultValue: "₹999" },
      { key: "offerText", label: "Offer text", type: "text", defaultValue: "Today only" },
      { key: "brandColor", label: "Brand color", type: "color", defaultValue: "#C9FF4A" }
    ]),
    creditCost: 14
  }),
  buildTemplate({
    name: "Podcast Clip Reel",
    slug: "podcast-clip-reel",
    category: "Captions",
    description: "Clean speaker labels, highlighted words, and readable social captions.",
    durationSeconds: 15,
    requiredModules: ["AUTO_CAPTIONS", "MOTION_TEXT", "FINAL_RENDER"],
    editableFields: fields([
      { key: "speakerName", label: "Speaker name", type: "text", defaultValue: "Guest" },
      { key: "captionStyle", label: "Caption style", type: "select", defaultValue: "clean_white", options: ["clean_white", "bold_yellow", "creator_pop"] },
      { key: "highlightWords", label: "Highlight words", type: "text", defaultValue: "growth,focus,truth" }
    ]),
    creditCost: 16
  }),
  buildTemplate({
    name: "Before / After Reel",
    slug: "before-after-reel",
    category: "Transformation",
    description: "Split reveal, zoom reset, and compact before-after labels.",
    durationSeconds: 10,
    requiredModules: ["ZOOM_CUTS", "MOTION_TEXT", "FINAL_RENDER"],
    editableFields: fields([
      { key: "beforeText", label: "Before text", type: "text", defaultValue: "Before" },
      { key: "afterText", label: "After text", type: "text", defaultValue: "After" },
      { key: "transitionStyle", label: "Transition style", type: "select", defaultValue: "snap", options: ["snap", "wipe", "flash"] }
    ]),
    creditCost: 12
  }),
  buildTemplate({
    name: "Motivational Reel",
    slug: "motivational-reel",
    category: "Story",
    description: "Quote-led reel with punch captions, gentle zooms, and uplifting pacing.",
    durationSeconds: 15,
    requiredModules: ["AUTO_CAPTIONS", "MOTION_TEXT", "ZOOM_CUTS", "FINAL_RENDER"],
    editableFields: fields([
      { key: "quoteText", label: "Quote text", type: "text", defaultValue: "Discipline creates freedom." },
      { key: "musicMood", label: "Music mood", type: "select", defaultValue: "uplifting", options: ["uplifting", "calm", "intense"] },
      { key: "captionStyle", label: "Caption style", type: "select", defaultValue: "creator_pop", options: ["creator_pop", "bold_yellow", "clean_white"] }
    ]),
    creditCost: 18
  })
];
