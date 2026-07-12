import type { DeviceCapabilityFlag } from "./skill-types";

/**
 * Executor registry — the tool analog of `model-registry.ts`.
 *
 * Where the generation model registry answers "which model can do this generation task",
 * this registry answers "which runtime can execute this tool task": a real browser-side ML
 * pass (`browser-real`), a future cloud tool service (`cloud`, contract-only stub today), or
 * the schema-compatible `mock` fallback that already exists in `tool-runner.ts`. The resolver
 * (`resolveExecutor.ts`) filters by task support + live availability and ranks local-real-first,
 * mirroring `resolveModels`'s local-first bias for generation.
 */

export type ExecutorKind = "browser-real" | "cloud" | "mock";
export type ExecutorQuality = "draft" | "standard" | "high";
export type ExecutorLatency = "fast" | "medium" | "slow";

/**
 * How an executor becomes available. "device" = browser-real (needs `deviceFlags` all true);
 * "cloudKey" = needs the cloud tool service (contract stub — always unavailable today);
 * "always" = the mock adapter, always available as a last resort.
 */
export type ExecutorAvailabilityReq = "device" | "cloudKey" | "always";

export interface ToolExecutor {
  id: string;
  label: string;
  kind: ExecutorKind;
  /** Skill task-kind ids (from skill-registry.ts) this executor can run. */
  taskKinds: string[];
  /** Browser-real only: device flags that must ALL be present. Empty for cloud/mock. */
  deviceFlags: DeviceCapabilityFlag[];
  availabilityReq: ExecutorAvailabilityReq;
  qualityTier: ExecutorQuality;
  latencyClass: ExecutorLatency;
  /** Credits metadata only (0 for browser-real/mock; no gating per project convention). */
  cost: number;
}

/** Seeded in skill-registry.ts's task ids — populated once those ids are defined (see M3/M4). */
export const executorRegistry: ToolExecutor[] = [
  // ---- browser-real ----
  {
    id: "browser-caption-whisper",
    label: "Local transcription (Whisper)",
    kind: "browser-real",
    taskKinds: ["auto-caption"],
    deviceFlags: ["webWorkers"],
    availabilityReq: "device",
    qualityTier: "standard",
    latencyClass: "medium",
    cost: 0
  },
  {
    id: "browser-person-matte",
    label: "Local person segmentation",
    kind: "browser-real",
    taskKinds: ["extract-person"],
    deviceFlags: ["webWorkers"],
    availabilityReq: "device",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 0
  },
  {
    id: "browser-subject-roto",
    label: "Local point-prompted roto (SlimSAM)",
    kind: "browser-real",
    taskKinds: ["roto-subject"],
    deviceFlags: ["webWorkers"],
    availabilityReq: "device",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 0
  },
  {
    id: "browser-background-removal",
    label: "Local background removal",
    kind: "browser-real",
    taskKinds: ["remove-background-transparent", "remove-background-greenscreen"],
    deviceFlags: ["webWorkers"],
    availabilityReq: "device",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 0
  },
  {
    id: "browser-object-removal",
    label: "Local inpainting (LaMa)",
    kind: "browser-real",
    taskKinds: ["remove-person"],
    deviceFlags: ["webWorkers"],
    availabilityReq: "device",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 0
  },
  {
    id: "browser-follow-text",
    label: "Local planar tracking",
    kind: "browser-real",
    taskKinds: ["follow-text", "stabilize-subject"],
    deviceFlags: ["webWorkers"],
    availabilityReq: "device",
    qualityTier: "standard",
    latencyClass: "medium",
    cost: 0
  },
  {
    id: "browser-text-behind",
    label: "Local background removal (for text-behind composite)",
    kind: "browser-real",
    taskKinds: ["text-behind-person"],
    deviceFlags: ["webWorkers"],
    availabilityReq: "device",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 0
  },

  // ---- cloud (contract-only stub; availability.cloud is false today) ----
  {
    id: "cloud-caption",
    label: "Cloud transcription",
    kind: "cloud",
    taskKinds: ["auto-caption"],
    deviceFlags: [],
    availabilityReq: "cloudKey",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 10
  },
  {
    id: "cloud-person-matte",
    label: "Cloud person segmentation",
    kind: "cloud",
    taskKinds: ["extract-person"],
    deviceFlags: [],
    availabilityReq: "cloudKey",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 9
  },
  {
    id: "cloud-subject-roto",
    label: "Cloud roto",
    kind: "cloud",
    taskKinds: ["roto-subject"],
    deviceFlags: [],
    availabilityReq: "cloudKey",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 10
  },
  {
    id: "cloud-background-removal",
    label: "Cloud background removal",
    kind: "cloud",
    taskKinds: ["remove-background-transparent", "remove-background-greenscreen"],
    deviceFlags: [],
    availabilityReq: "cloudKey",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 12
  },
  {
    id: "cloud-object-removal",
    label: "Cloud inpainting",
    kind: "cloud",
    taskKinds: ["remove-person"],
    deviceFlags: [],
    availabilityReq: "cloudKey",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 12
  },
  {
    id: "cloud-follow-text",
    label: "Cloud tracking",
    kind: "cloud",
    taskKinds: ["follow-text", "stabilize-subject"],
    deviceFlags: [],
    availabilityReq: "cloudKey",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 0
  },
  {
    id: "cloud-text-behind",
    label: "Cloud background removal (for text-behind composite)",
    kind: "cloud",
    taskKinds: ["text-behind-person"],
    deviceFlags: [],
    availabilityReq: "cloudKey",
    qualityTier: "high",
    latencyClass: "slow",
    cost: 14
  },

  // ---- mock (always available — the existing tool-runner.ts fallback) ----
  {
    id: "mock-caption",
    label: "Mock adapter",
    kind: "mock",
    taskKinds: ["auto-caption"],
    deviceFlags: [],
    availabilityReq: "always",
    qualityTier: "draft",
    latencyClass: "fast",
    cost: 0
  },
  {
    id: "mock-person-matte",
    label: "Mock adapter",
    kind: "mock",
    taskKinds: ["extract-person"],
    deviceFlags: [],
    availabilityReq: "always",
    qualityTier: "draft",
    latencyClass: "fast",
    cost: 0
  },
  {
    id: "mock-subject-roto",
    label: "Mock adapter",
    kind: "mock",
    taskKinds: ["roto-subject"],
    deviceFlags: [],
    availabilityReq: "always",
    qualityTier: "draft",
    latencyClass: "fast",
    cost: 0
  },
  {
    id: "mock-background-removal",
    label: "Mock adapter",
    kind: "mock",
    taskKinds: ["remove-background-transparent", "remove-background-greenscreen"],
    deviceFlags: [],
    availabilityReq: "always",
    qualityTier: "draft",
    latencyClass: "fast",
    cost: 0
  },
  {
    id: "mock-object-removal",
    label: "Mock adapter",
    kind: "mock",
    taskKinds: ["remove-person"],
    deviceFlags: [],
    availabilityReq: "always",
    qualityTier: "draft",
    latencyClass: "fast",
    cost: 0
  },
  {
    id: "mock-follow-text",
    label: "Mock adapter",
    kind: "mock",
    taskKinds: ["follow-text", "stabilize-subject"],
    deviceFlags: [],
    availabilityReq: "always",
    qualityTier: "draft",
    latencyClass: "fast",
    cost: 0
  },
  {
    id: "mock-text-behind",
    label: "Mock adapter",
    kind: "mock",
    taskKinds: ["text-behind-person"],
    deviceFlags: [],
    availabilityReq: "always",
    qualityTier: "draft",
    latencyClass: "fast",
    cost: 0
  }
];

export function getExecutor(id: string): ToolExecutor | undefined {
  return executorRegistry.find((executor) => executor.id === id);
}
