import { z } from "zod";
import type { EffectModule, ModuleType, PublicEffectModule, ToolDefinition, WalletPack } from "./types";
import { toolDefinitionsFromCapabilities } from "./tools";

const qualitySchema = z.object({
  quality: z.enum(["preview", "balanced", "final"]).default("preview")
});

// TODO(phase1): source estimatedCostCredits from creditCost() (billing/pricing.ts) instead of a
// hardcoded flat number per module — left as-is this phase (additive-only, don't touch shipped code).
export const moduleCatalog: EffectModule[] = [
  {
    id: "mod_person_extraction",
    type: "PERSON_EXTRACTION",
    name: "Person Extraction",
    description: "Segments the primary subject and produces masks, cutouts, and matte metadata.",
    inputTypes: ["source_video"],
    outputTypes: ["person_mask", "person_cutout"],
    configSchema: qualitySchema.extend({ edgeMode: z.enum(["fast", "clean"]).default("fast") }),
    estimatedCostCredits: 5,
    status: "mocked"
  },
  {
    id: "mod_person_tracking",
    type: "PERSON_TRACKING",
    name: "Person Tracking",
    description: "Tracks subject motion over time for follow text, depth shifts, and zoom cues.",
    inputTypes: ["source_video", "person_mask"],
    outputTypes: ["tracking_data"],
    configSchema: qualitySchema.extend({ smoothing: z.number().min(0).max(1).default(0.45) }),
    estimatedCostCredits: 4,
    status: "mocked"
  },
  {
    id: "mod_background_removal",
    type: "BACKGROUND_REMOVAL",
    name: "Background Removal",
    description: "Creates a transparent or green-screen-ready version of the source clip.",
    inputTypes: ["source_video"],
    outputTypes: ["person_cutout", "background_plate"],
    configSchema: qualitySchema.extend({ outputMode: z.enum(["transparent", "green_screen"]).default("transparent") }),
    estimatedCostCredits: 6,
    status: "mocked"
  },
  {
    id: "mod_person_removal",
    type: "PERSON_REMOVAL",
    name: "Remove Person",
    description: "Selects a person/object, tracks it, and inpaints a clean clip with the subject removed.",
    inputTypes: ["source_video", "person_mask"],
    outputTypes: ["preview_video"],
    configSchema: z.object({
      selectionMode: z.enum(["tap", "brush"]).default("tap"),
      inpaintQuality: z.enum(["preview", "balanced", "final"]).default("preview"),
      feather: z.number().min(0).max(40).default(6)
    }),
    estimatedCostCredits: 8,
    status: "mocked"
  },
  {
    id: "mod_text_behind_person",
    type: "TEXT_BEHIND_PERSON",
    name: "Text Behind Person",
    description: "Places big typography behind the subject using the extracted mask.",
    inputTypes: ["source_video", "person_mask"],
    outputTypes: ["motion_text_layer"],
    configSchema: z.object({
      text: z.string().default("REEL MODE"),
      depthFeel: z.number().min(0).max(1).default(0.68),
      textPosition: z.enum(["behind_person", "center", "top", "bottom"]).default("behind_person"),
      textColor: z.string().default("#C9FF4A")
    }),
    estimatedCostCredits: 3,
    status: "available"
  },
  {
    id: "mod_smart_3d_follow_text",
    type: "SMART_3D_FOLLOW_TEXT",
    name: "Smart 3D Follow Text",
    description: "Makes text follow the subject path with scale, depth, and motion blur.",
    inputTypes: ["source_video", "person_mask", "tracking_data"],
    outputTypes: ["motion_text_layer"],
    configSchema: z.object({
      text: z.string().default("SKATE MODE"),
      depthStrength: z.number().min(0).max(1).default(0.7),
      trackingStyle: z.enum(["locked", "cinematic", "snappy"]).default("cinematic"),
      shadow: z.boolean().default(true),
      motionBlur: z.boolean().default(true)
    }),
    estimatedCostCredits: 0,
    status: "available"
  },
  {
    id: "mod_auto_captions",
    type: "AUTO_CAPTIONS",
    name: "Auto Captions",
    description: "Generates punchy captions from source audio and highlights high-impact words.",
    inputTypes: ["source_video", "source_audio"],
    outputTypes: ["caption_data", "motion_text_layer"],
    configSchema: z.object({
      language: z.enum(["english", "hindi", "hinglish"]).default("hinglish"),
      captionStyle: z.enum(["bold_yellow", "clean_white", "creator_pop"]).default("bold_yellow"),
      punchWords: z.string().default("wait,secret,proof")
    }),
    estimatedCostCredits: 4,
    status: "mocked"
  },
  {
    id: "mod_beat_sync",
    type: "BEAT_SYNC",
    name: "Beat Sync",
    description: "Finds beat moments and aligns edits, pops, and zooms to music.",
    inputTypes: ["source_audio"],
    outputTypes: ["beat_map"],
    configSchema: z.object({ energy: z.enum(["low", "medium", "high"]).default("medium") }),
    estimatedCostCredits: 3,
    status: "experimental"
  },
  {
    id: "mod_zoom_cuts",
    type: "ZOOM_CUTS",
    name: "Zoom Cuts",
    description: "Adds creator-style punch-in edits, quick resets, and beat zooms.",
    inputTypes: ["source_video"],
    outputTypes: ["motion_text_layer"],
    configSchema: z.object({
      intensity: z.enum(["soft", "medium", "viral"]).default("medium"),
      frequency: z.number().min(1).max(8).default(4)
    }),
    estimatedCostCredits: 3,
    status: "available"
  },
  {
    id: "mod_background_replacement",
    type: "BACKGROUND_REPLACEMENT",
    name: "Background Replacement",
    description: "Places the subject over a stylized plate, evidence board, product shelf, or solid backdrop.",
    inputTypes: ["source_video", "person_mask"],
    outputTypes: ["background_plate", "preview_video"],
    configSchema: z.object({
      backgroundStyle: z.enum(["dark_crime", "studio", "clean_product", "gradient"]).default("dark_crime"),
      blur: z.number().min(0).max(20).default(6)
    }),
    estimatedCostCredits: 5,
    status: "mocked"
  },
  {
    id: "mod_motion_text",
    type: "MOTION_TEXT",
    name: "Motion Text",
    description: "Adds kinetic titles, hooks, warnings, price tags, and animated quote cards.",
    inputTypes: ["source_video"],
    outputTypes: ["motion_text_layer"],
    configSchema: z.object({
      text: z.string().default("NEW DROP"),
      style: z.enum(["minimal", "bold", "crime", "promo"]).default("bold")
    }),
    estimatedCostCredits: 2,
    status: "available"
  },
  {
    id: "mod_final_render",
    type: "FINAL_RENDER",
    name: "Final Render",
    description: "Renders the project graph into a 720p export without preview watermark.",
    inputTypes: ["project_graph", "source_video"],
    outputTypes: ["final_video"],
    configSchema: z.object({
      resolution: z.enum(["720p", "1080p"]).default("720p"),
      watermark: z.boolean().default(false)
    }),
    estimatedCostCredits: 1,
    status: "mocked"
  }
];

export const toolDefinitions: ToolDefinition[] = toolDefinitionsFromCapabilities;

export const walletPacks: WalletPack[] = [
  { id: "starter", name: "Starter", priceInr: 29, credits: 30, description: "Try a few preview-to-export flows." },
  { id: "creator", name: "Creator", priceInr: 49, credits: 60, description: "Best first pack for weekly reels." },
  { id: "growth", name: "Growth", priceInr: 99, credits: 150, description: "Lower-cost credits for batch editing." }
];

export const mvpLimits = [
  "Max 15 sec video",
  "Portrait 9:16 recommended",
  "One person works best",
  "720p final export",
  "Preview includes watermark",
  "Advanced hair and crowd cutout is experimental"
];

export function getModule(type: ModuleType): EffectModule {
  const module = moduleCatalog.find((item) => item.type === type);
  if (!module) {
    throw new Error(`Unknown module type: ${type}`);
  }
  return module;
}

export function toPublicModule(module: EffectModule): PublicEffectModule {
  return {
    ...module,
    configFields: inferConfigFields(module.type)
  };
}

export function inferConfigFields(type: ModuleType) {
  switch (type) {
    case "TEXT_BEHIND_PERSON":
      return [
        { key: "text", label: "Main text", type: "text" as const, defaultValue: "REEL MODE" },
        { key: "textColor", label: "Text color", type: "color" as const, defaultValue: "#C9FF4A" },
        { key: "depthFeel", label: "Depth feel", type: "number" as const, defaultValue: 0.68 }
      ];
    case "SMART_3D_FOLLOW_TEXT":
      return [
        { key: "text", label: "Follow text", type: "text" as const, defaultValue: "SKATE MODE" },
        { key: "depthStrength", label: "Depth strength", type: "number" as const, defaultValue: 0.7 },
        { key: "motionBlur", label: "Motion blur", type: "boolean" as const, defaultValue: true }
      ];
    case "AUTO_CAPTIONS":
      return [
        { key: "language", label: "Language", type: "select" as const, defaultValue: "hinglish", options: ["english", "hindi", "hinglish"] },
        { key: "captionStyle", label: "Caption style", type: "select" as const, defaultValue: "bold_yellow", options: ["bold_yellow", "clean_white", "creator_pop"] }
      ];
    default:
      return [{ key: "quality", label: "Quality", type: "select" as const, defaultValue: "preview", options: ["preview", "balanced", "final"] }];
  }
}
