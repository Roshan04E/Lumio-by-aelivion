import { z } from "zod";

export const pluginSchemaVersion = "1.0.0" as const;

export const pluginPackageKindSchema = z.enum(["effect", "transition", "look", "timeline-template", "look-pack", "bundle"]);
export const pluginAssetKindSchema = z.enum(["video", "image", "audio", "font", "lut", "json", "thumbnail", "preview", "other"]);
export const pluginRuntimeSchema = z.enum(["web", "worker", "remotion", "server"]);
export const pluginRendererSchema = z.enum(["dom", "webgl2", "scene-compositor", "remotion-scene"]);

export const pluginEffectEngineSchema = z.enum(["native", "color-pipeline", "lut3d", "css-filter", "webgl-fragment", "composite"]);
export const pluginTransitionEngineSchema = z.enum(["native", "webgl-transition"]);
export const pluginLookEngineSchema = z.enum(["color-pipeline", "lut3d", "native"]);

export const pluginParamTypeSchema = z.enum(["number", "string", "boolean", "color", "select", "vec2", "vec3", "curve", "wheels", "lut"]);

const pluginStringIdSchema = z
  .string()
  .min(2)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Use letters, numbers, '.', '_', ':', or '-' and start with a letter or number.");

const pluginUrlOrRelativePathSchema = z.string().min(1).max(2048);

export const pluginAuthorSchema = z.object({
  id: z.string().min(1).max(160).optional(),
  name: z.string().min(1).max(160),
  url: z.string().url().optional()
});

export const pluginLicenseSchema = z.object({
  type: z.enum(["free", "paid", "custom", "unknown"]).default("unknown"),
  name: z.string().min(1).max(160).optional(),
  url: z.string().url().optional()
});

export const pluginCompatibilitySchema = z.object({
  minAppVersion: z.string().min(1).max(40).optional(),
  maxAppVersion: z.string().min(1).max(40).optional(),
  runtimes: z.array(pluginRuntimeSchema).default(["web"]),
  renderers: z.array(pluginRendererSchema).default(["webgl2", "scene-compositor"]),
  aspectRatios: z.array(z.string().min(3).max(20)).default([]),
  requiresWebgl2: z.boolean().default(false),
  requiredFeatures: z.array(z.string().min(1).max(120)).default([])
});

export const pluginAssetRefSchema = z.object({
  id: pluginStringIdSchema,
  kind: pluginAssetKindSchema,
  path: pluginUrlOrRelativePathSchema,
  mimeType: z.string().min(1).max(160).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  sizeBytes: z.number().nonnegative().optional(),
  hash: z.string().min(1).max(160).optional()
});

export const pluginParamOptionSchema = z.object({
  label: z.string().min(1).max(120),
  value: z.union([z.string(), z.number(), z.boolean()])
});

export const pluginParamSchema = z.object({
  key: pluginStringIdSchema,
  label: z.string().min(1).max(120),
  type: pluginParamTypeSchema,
  defaultValue: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  unit: z.string().min(1).max(24).optional(),
  options: z.array(pluginParamOptionSchema).optional(),
  keyframeable: z.boolean().default(false),
  description: z.string().max(500).optional()
});

export const pluginEntrySchema = z.object({
  id: pluginStringIdSchema,
  kind: pluginPackageKindSchema,
  path: pluginUrlOrRelativePathSchema,
  name: z.string().min(1).max(160).optional()
});

export const pluginWarningSchema = z.object({
  code: pluginStringIdSchema,
  message: z.string().min(1).max(500),
  severity: z.enum(["info", "warning", "error"]).default("warning")
});

const pluginManifestBaseSchema = z.object({
  schemaVersion: z.literal(pluginSchemaVersion),
  kind: pluginPackageKindSchema,
  id: pluginStringIdSchema,
  name: z.string().min(1).max(160),
  version: z.string().min(1).max(40).default("1.0.0"),
  description: z.string().max(1000).optional(),
  author: pluginAuthorSchema.optional(),
  license: pluginLicenseSchema.default({ type: "unknown" }),
  tags: z.array(z.string().min(1).max(60)).default([]),
  category: z.string().min(1).max(120).optional(),
  thumbnail: pluginUrlOrRelativePathSchema.optional(),
  preview: pluginUrlOrRelativePathSchema.optional(),
  compatibility: pluginCompatibilitySchema.default({}),
  assets: z.array(pluginAssetRefSchema).default([]),
  params: z.array(pluginParamSchema).default([]),
  entries: z.array(pluginEntrySchema).default([]),
  warnings: z.array(pluginWarningSchema).default([])
});

export const pluginEffectManifestSchema = pluginManifestBaseSchema.extend({
  kind: z.literal("effect"),
  engine: pluginEffectEngineSchema,
  scope: z.array(z.enum(["clip", "track", "adjustment", "transition"])).default(["clip"]),
  compatibleLayerTypes: z.array(z.enum(["video", "image", "text", "audio", "shape", "adjustment"])).default(["video", "image"]),
  effect: z.record(z.unknown()).default({})
});

export const pluginTransitionManifestSchema = pluginManifestBaseSchema.extend({
  kind: z.literal("transition"),
  engine: pluginTransitionEngineSchema,
  defaultDurationSeconds: z.number().positive().max(30).default(0.5),
  easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]).default("easeInOut"),
  transition: z
    .object({
      glsl: z.string().min(1).max(60_000).optional(),
      params: z.array(pluginParamSchema).default([])
    })
    .default({ params: [] })
});

export const pluginLookManifestSchema = pluginManifestBaseSchema.extend({
  kind: z.literal("look"),
  engine: pluginLookEngineSchema,
  scope: z.array(z.enum(["clip", "adjustment"])).default(["clip", "adjustment"]),
  look: z.record(z.unknown()).default({})
});

export const pluginTimelineTemplateManifestSchema = pluginManifestBaseSchema.extend({
  kind: z.literal("timeline-template"),
  entry: pluginUrlOrRelativePathSchema.default("timeline.json"),
  slots: z
    .array(
      z.object({
        id: pluginStringIdSchema,
        label: z.string().min(1).max(120),
        accepts: z.array(z.enum(["video", "image", "audio", "text", "color"])).default(["video", "image"]),
        required: z.boolean().default(true),
        replaceBehavior: z.enum(["preserve-duration", "preserve-source-duration", "stretch-to-slot"]).default("preserve-duration"),
        targetLayerIds: z.array(z.string().min(1)).default([])
      })
    )
    .default([])
});

export const pluginLookPackManifestSchema = pluginManifestBaseSchema.extend({
  kind: z.literal("look-pack"),
  entries: z.array(pluginEntrySchema.extend({ kind: z.literal("look") })).min(1)
});

export const pluginBundleManifestSchema = pluginManifestBaseSchema.extend({
  kind: z.literal("bundle"),
  entries: z.array(pluginEntrySchema).min(1)
});

export const pluginManifestSchema = z.discriminatedUnion("kind", [
  pluginEffectManifestSchema,
  pluginTransitionManifestSchema,
  pluginLookManifestSchema,
  pluginTimelineTemplateManifestSchema,
  pluginLookPackManifestSchema,
  pluginBundleManifestSchema
]);

export type PluginPackageKind = z.infer<typeof pluginPackageKindSchema>;
export type PluginAssetKind = z.infer<typeof pluginAssetKindSchema>;
export type PluginRuntime = z.infer<typeof pluginRuntimeSchema>;
export type PluginRenderer = z.infer<typeof pluginRendererSchema>;
export type PluginEffectEngine = z.infer<typeof pluginEffectEngineSchema>;
export type PluginTransitionEngine = z.infer<typeof pluginTransitionEngineSchema>;
export type PluginLookEngine = z.infer<typeof pluginLookEngineSchema>;
export type PluginParam = z.infer<typeof pluginParamSchema>;
export type PluginAssetRef = z.infer<typeof pluginAssetRefSchema>;
export type PluginEntry = z.infer<typeof pluginEntrySchema>;
export type PluginWarning = z.infer<typeof pluginWarningSchema>;
export type PluginEffectManifest = z.infer<typeof pluginEffectManifestSchema>;
export type PluginTransitionManifest = z.infer<typeof pluginTransitionManifestSchema>;
export type PluginLookManifest = z.infer<typeof pluginLookManifestSchema>;
export type PluginTimelineTemplateManifest = z.infer<typeof pluginTimelineTemplateManifestSchema>;
export type PluginLookPackManifest = z.infer<typeof pluginLookPackManifestSchema>;
export type PluginBundleManifest = z.infer<typeof pluginBundleManifestSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export function parsePluginManifest(value: unknown): PluginManifest {
  return pluginManifestSchema.parse(value);
}

export function safeParsePluginManifest(value: unknown): z.SafeParseReturnType<unknown, PluginManifest> {
  return pluginManifestSchema.safeParse(value);
}
