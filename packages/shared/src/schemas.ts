import { z } from "zod";
import { moduleTypes } from "./types";

export const moduleTypeSchema = z.enum(moduleTypes);

export const signupSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128)
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const googleAuthSchema = z.object({
  credential: z.string().min(1)
});

export const assetSourceSchema = z.enum([
  "local",
  "ai",
  "pexels",
  "unsplash",
  "graphic",
  "timeline-generated",
  "brand"
]);

/** Parse a value that may arrive as a JSON string (FormData) or already-parsed object. */
const jsonField = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }, schema.optional());

export const createAssetSchema = z.object({
  fileName: z.string().min(1).default("demo-clip.mp4"),
  fileType: z.string().min(1).default("video/mp4"),
  durationSeconds: z.coerce.number().min(0.2).max(7200).default(12),
  width: z.coerce.number().min(320).default(1080),
  height: z.coerce.number().min(320).default(1920),
  // --- Media-library metadata (optional) ---
  source: assetSourceSchema.optional(),
  folder: z.string().max(120).optional(),
  originalName: z.string().max(260).optional(),
  thumbnailUrl: z.string().max(2_000_000).optional(),
  fps: z.coerce.number().min(1).max(240).optional(),
  sizeBytes: z.coerce.number().min(0).optional(),
  projectId: z.string().optional(),
  tags: jsonField(z.array(z.string())),
  external: jsonField(
    z.object({
      provider: z.enum(["pexels", "unsplash", "iconify"]),
      externalId: z.string(),
      author: z.string().optional(),
      sourceUrl: z.string().optional(),
      license: z.string().optional()
    })
  ),
  ai: jsonField(
    z.object({
      model: z.string().optional(),
      prompt: z.string().optional(),
      seed: z.string().optional(),
      referenceAssetIds: z.array(z.string()).optional()
    })
  ),
  // Detected source color metadata (Rec.709 SDR contract). Loose object — the server re-normalizes it
  // via `normalizeSourceColorMetadata` before use, so we only need to accept the JSON shape here.
  color: jsonField(
    z.object({
      primaries: z.string().optional(),
      transfer: z.string().optional(),
      matrix: z.string().optional(),
      fullRange: z.boolean().optional(),
      bitDepth: z.number().optional(),
      detectedFrom: z.string().optional(),
      confidence: z.string().optional()
    }).passthrough()
  )
});

export const createProjectSchema = z.object({
  title: z.string().min(1).max(120).default("Untitled reel"),
  templateId: z.string().optional(),
  sourceAssetId: z.string().optional(),
  prompt: z.string().max(600).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
  // Create-only goal presets (the /create style tiles) carry deterministic project properties:
  // a frame rate, a starting module stack, and a target duration for footage-less drafts.
  fps: z.number().int().min(12).max(120).optional(),
  effects: z.array(moduleTypeSchema).optional(),
  durationSeconds: z.coerce.number().min(1).max(7200).optional()
});

export const patchProjectSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  status: z.enum(["draft", "preview_ready", "export_ready", "archived"]).optional(),
  projectGraph: z.unknown().optional(),
  // Floor at 0, not 0.2: a composition can legitimately be a single frame (~0.033s) while
  // the user trims/tests; the timeline drives real durations, this is just a sanity bound.
  durationSeconds: z.coerce.number().min(0).max(7200).optional()
});

export const applyTemplateSchema = z.object({
  templateId: z.string()
});

export const addEffectSchema = z.object({
  type: moduleTypeSchema,
  config: z.record(z.unknown()).default({})
});

export const createTemplateSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2),
  category: z.string().min(2),
  description: z.string().min(2),
  previewUrl: z.string().default("/assets/template-custom.jpg"),
  thumbnailUrl: z.string().default("/assets/template-custom.jpg"),
  durationSeconds: z.coerce.number().min(1).max(7200),
  // Module-stack templates list their modules here; composition-based
  // (save-as-template) templates carry the authored composition instead and may
  // have no module stack, so an empty list is allowed.
  requiredModules: z.array(moduleTypeSchema).default([]),
  editableFields: z.array(z.record(z.unknown())).default([]),
  templateGraph: z.unknown(),
  active: z.boolean().default(true)
});

export const patchTemplateSchema = createTemplateSchema.partial();

export const createOrderSchema = z.object({
  packId: z.enum(["starter", "creator", "growth"]),
  projectId: z.string().optional()
});

export const verifyPaymentSchema = z.object({
  paymentId: z.string(),
  providerPaymentId: z.string().default("mock_provider_payment"),
  signature: z.string().optional()
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type AddEffectInput = z.infer<typeof addEffectSchema>;
