import type {
  CapabilityConstraints,
  GenerationInputType,
  GenerationModality
} from "./skill-types";

/**
 * Model capability registry — the declarative source of truth the resolver reads to
 * answer "which model is capable of this task, and is it available right now".
 *
 * This is the generation-side analog of the multi-provider text gateway pool
 * (`aiGateway.service.ts`): each entry declares what a concrete model can do and what
 * it needs to be available (a cloud key, a reachable local endpoint, or a BYO key).
 * The resolver (`resolveModels`) filters by capability + availability and ranks.
 *
 * Cost is metadata only (no gating) per project convention. Local models are free (0).
 */

export type GenerationProvider = "fal" | "local" | "byo";
/** What must be true for this model to be usable. */
export type AvailabilityReq = "falKey" | "localEndpoint" | "byoKey";
export type QualityTier = "draft" | "standard" | "high";
export type LatencyClass = "fast" | "medium" | "slow";

export interface GenerationModel {
  /** Internal stable id. */
  id: string;
  label: string;
  provider: GenerationProvider;
  /** The provider-native model id, e.g. a fal endpoint slug or a local checkpoint name. */
  providerModelId: string;
  /** SkillTaskKind ids this model can execute. */
  taskKinds: string[];
  modalities: GenerationModality[];
  inputs: GenerationInputType[];
  constraints: CapabilityConstraints;
  /** Credits metadata (0 for local/free). */
  cost: number;
  qualityTier: QualityTier;
  latencyClass: LatencyClass;
  availabilityReq: AvailabilityReq;
}

const IMAGE_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const VIDEO_ASPECTS = ["16:9", "9:16", "1:1"];

export const modelCapabilityRegistry: GenerationModel[] = [
  // ---- Local (free, image-only) — mirrors the local-first Ollama route ----
  {
    id: "local-sd",
    label: "Local Stable Diffusion",
    provider: "local",
    providerModelId: "local:default",
    taskKinds: ["text-to-image", "image-to-image", "inpaint"],
    modalities: ["image"],
    inputs: ["text", "image", "mask"],
    constraints: { aspectRatios: IMAGE_ASPECTS, maxResolution: 1536 },
    cost: 0,
    qualityTier: "standard",
    latencyClass: "medium",
    availabilityReq: "localEndpoint"
  },

  // ---- fal.ai cloud (image) ----
  {
    id: "fal-flux-dev",
    label: "FLUX.1 [dev]",
    provider: "fal",
    providerModelId: "fal-ai/flux/dev",
    taskKinds: ["text-to-image"],
    modalities: ["image"],
    inputs: ["text"],
    constraints: { aspectRatios: IMAGE_ASPECTS, maxResolution: 1440 },
    cost: 4,
    qualityTier: "high",
    latencyClass: "medium",
    availabilityReq: "falKey"
  },
  {
    id: "fal-flux-schnell",
    label: "FLUX.1 [schnell]",
    provider: "fal",
    providerModelId: "fal-ai/flux/schnell",
    taskKinds: ["text-to-image"],
    modalities: ["image"],
    inputs: ["text"],
    constraints: { aspectRatios: IMAGE_ASPECTS, maxResolution: 1440 },
    cost: 2,
    qualityTier: "standard",
    latencyClass: "fast",
    availabilityReq: "falKey"
  },
  {
    id: "fal-flux-img2img",
    label: "FLUX image-to-image",
    provider: "fal",
    providerModelId: "fal-ai/flux/dev/image-to-image",
    taskKinds: ["image-to-image"],
    modalities: ["image"],
    inputs: ["text", "image"],
    constraints: { aspectRatios: IMAGE_ASPECTS, maxResolution: 1440 },
    cost: 4,
    qualityTier: "high",
    latencyClass: "medium",
    availabilityReq: "falKey"
  },
  {
    id: "fal-flux-inpaint",
    label: "FLUX inpaint",
    provider: "fal",
    providerModelId: "fal-ai/flux-lora/inpainting",
    taskKinds: ["inpaint", "outpaint"],
    modalities: ["image"],
    inputs: ["text", "image", "mask"],
    constraints: { aspectRatios: IMAGE_ASPECTS, maxResolution: 1440 },
    cost: 5,
    qualityTier: "high",
    latencyClass: "medium",
    availabilityReq: "falKey"
  },
  {
    id: "fal-esrgan",
    label: "Upscale (ESRGAN)",
    provider: "fal",
    providerModelId: "fal-ai/esrgan",
    taskKinds: ["upscale"],
    modalities: ["image"],
    inputs: ["image"],
    constraints: { maxResolution: 4096 },
    cost: 2,
    qualityTier: "standard",
    latencyClass: "fast",
    availabilityReq: "falKey"
  },

  // ---- fal.ai cloud (video) ----
  {
    id: "fal-ltx-t2v",
    label: "LTX Video (text-to-video)",
    provider: "fal",
    providerModelId: "fal-ai/ltx-video",
    taskKinds: ["text-to-video"],
    modalities: ["video"],
    inputs: ["text"],
    constraints: { aspectRatios: VIDEO_ASPECTS, maxDurationSeconds: 5, maxResolution: 768 },
    cost: 20,
    qualityTier: "standard",
    latencyClass: "slow",
    availabilityReq: "falKey"
  },
  {
    id: "fal-kling-i2v",
    label: "Kling (image-to-video)",
    provider: "fal",
    providerModelId: "fal-ai/kling-video/v1/standard/image-to-video",
    taskKinds: ["image-to-video"],
    modalities: ["video"],
    inputs: ["text", "image"],
    constraints: { aspectRatios: VIDEO_ASPECTS, maxDurationSeconds: 10, maxResolution: 1080 },
    cost: 40,
    qualityTier: "high",
    latencyClass: "slow",
    availabilityReq: "falKey"
  },
  {
    id: "fal-kling-t2v",
    label: "Kling (text-to-video)",
    provider: "fal",
    providerModelId: "fal-ai/kling-video/v1/standard/text-to-video",
    taskKinds: ["text-to-video"],
    modalities: ["video"],
    inputs: ["text"],
    constraints: { aspectRatios: VIDEO_ASPECTS, maxDurationSeconds: 10, maxResolution: 1080 },
    cost: 40,
    qualityTier: "high",
    latencyClass: "slow",
    availabilityReq: "falKey"
  }
];

export function getGenerationModel(id: string): GenerationModel | undefined {
  return modelCapabilityRegistry.find((model) => model.id === id);
}
