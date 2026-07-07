import { z } from "zod";
import type { Skill, SkillTaskKind } from "./skill-types";

/**
 * Skill registry — the always-disclosed catalog the planner reads. Only the asset
 * generation skill is implemented today; future skills register here the same way.
 */

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

/** Fields every generation task shares. */
const baseImageParams = {
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).default("1:1"),
  seed: z.number().int().optional(),
  variations: z.number().int().min(1).max(4).default(1)
};

/** A reference image: a data URL, http(s) URL, or an existing SourceAsset id. */
const imageRef = z.string().min(1);

const textToImageSchema = z.object({ ...baseImageParams });

const imageToImageSchema = z.object({
  ...baseImageParams,
  referenceImage: imageRef,
  strength: z.number().min(0).max(1).default(0.65)
});

const inpaintSchema = z.object({
  ...baseImageParams,
  referenceImage: imageRef,
  mask: imageRef
});

const outpaintSchema = z.object({
  ...baseImageParams,
  referenceImage: imageRef,
  mask: imageRef
});

const upscaleSchema = z.object({
  referenceImage: imageRef,
  scale: z.enum(["2x", "4x"]).default("2x")
});

const textToVideoSchema = z.object({
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).default("16:9"),
  durationSeconds: z.number().min(1).max(10).default(5),
  seed: z.number().int().optional()
});

const imageToVideoSchema = z.object({
  prompt: z.string().optional(),
  referenceImage: imageRef,
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).default("16:9"),
  durationSeconds: z.number().min(1).max(10).default(5),
  seed: z.number().int().optional()
});

const taskKinds: SkillTaskKind[] = [
  {
    id: "text-to-image",
    label: "Text to Image",
    modality: "image",
    inputs: ["text"],
    inputSchema: textToImageSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["text"] }
  },
  {
    id: "image-to-image",
    label: "Image to Image",
    modality: "image",
    inputs: ["text", "image"],
    inputSchema: imageToImageSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["text", "image"] }
  },
  {
    id: "inpaint",
    label: "Inpaint",
    modality: "image",
    inputs: ["text", "image", "mask"],
    inputSchema: inpaintSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["text", "image", "mask"] }
  },
  {
    id: "outpaint",
    label: "Outpaint",
    modality: "image",
    inputs: ["text", "image", "mask"],
    inputSchema: outpaintSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["text", "image", "mask"] }
  },
  {
    id: "upscale",
    label: "Upscale",
    modality: "image",
    inputs: ["image"],
    inputSchema: upscaleSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["image"] }
  },
  {
    id: "text-to-video",
    label: "Text to Video",
    modality: "video",
    inputs: ["text"],
    inputSchema: textToVideoSchema,
    outputArtifact: "generatedVideo",
    capabilityReq: { modality: "video", inputs: ["text"] }
  },
  {
    id: "image-to-video",
    label: "Image to Video",
    modality: "video",
    inputs: ["text", "image"],
    inputSchema: imageToVideoSchema,
    outputArtifact: "generatedVideo",
    capabilityReq: { modality: "video", inputs: ["text", "image"] }
  }
];

export const assetGenerationSkill: Skill = {
  id: "asset-generation",
  name: "AI Asset Generation",
  summary: "Generate images and video clips from a prompt or reference, ready to drop on the timeline.",
  aiSummary:
    "Generates net-new image and video assets from text and/or a reference image. Task kinds: text-to-image, image-to-image, inpaint, outpaint, upscale, text-to-video, image-to-video. Output lands as a SourceAsset in the media bin and can be placed as a layer.",
  procedure: [
    "1. Resolve the task kind from the user's intent (image vs video; whether a reference image or mask is provided).",
    "2. Build the task's params against its input schema (prompt, aspect ratio, duration, references).",
    "3. Resolve a capable + available model via the model registry (local-first for image when a local endpoint is reachable; cloud fal.ai otherwise; video is always cloud).",
    "4. Run generation (local: browser→localhost; cloud: server→fal, async job for video).",
    "5. Ingest the result as a SourceAsset (source=\"ai\") so it appears in the media library AI tab.",
    "6. Optionally place it on the timeline via createAssets/createLayers (one undo entry)."
  ].join("\n"),
  category: "generation",
  taskKinds
};

export const skillRegistry: Skill[] = [assetGenerationSkill];

export function getSkill(id: string): Skill | undefined {
  return skillRegistry.find((skill) => skill.id === id);
}

/**
 * Compact, always-disclosed skill description for the planner prompt. Mirrors
 * `describeForPlanner()` in the capability index — one `aiSummary` line per skill plus
 * its task-kind ids, so the planner can select generation without loading each skill's
 * full procedure (that's fetched on demand from `skill.procedure`).
 */
export function describeSkillsForPlanner(): string {
  return [
    "SKILLS (invoke via a 'skill' step with skillId + taskKind + params):",
    ...skillRegistry.map(
      (skill) =>
        `- ${skill.id} [${skill.taskKinds.map((task) => task.id).join(", ")}]: ${skill.aiSummary}`
    )
  ].join("\n");
}
