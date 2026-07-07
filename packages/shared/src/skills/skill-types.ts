import type { ZodTypeAny } from "zod";
import type { ToolArtifactType } from "../types";

/**
 * Skill engine — the general "AI knows what it's doing and how it's done" layer.
 *
 * A Skill is the generalization of the capability-index idea (`describeForPlanner`):
 * a capability packet whose *summary* is always disclosed to the planner, and whose
 * *procedure* (the "how") is loaded on demand — the same progressive-disclosure model
 * Claude Skills use (SKILL.md description always in context, full body loaded when
 * selected). Each Skill exposes typed `taskKinds`; each task kind declares a
 * `capabilityReq` that the model resolver (`resolveModels`) matches against the
 * `modelCapabilityRegistry` to answer "which model is capable of this".
 *
 * The only Skill implemented today is asset generation, but the abstraction is
 * deliberately generic so future skills (edit, restyle, analyze, ...) plug in the
 * same way.
 */

export type GenerationModality = "image" | "video" | "audio";
export type GenerationInputType = "text" | "image" | "mask";

/** Hard requirements a task places on any model that claims to execute it. */
export interface CapabilityConstraints {
  /** Video only: the clip length the task needs (seconds). */
  maxDurationSeconds?: number | undefined;
  /** Aspect ratios the task needs the model to support, e.g. ["1:1","16:9","9:16"]. */
  aspectRatios?: string[] | undefined;
  /** Long-edge resolution (px) the task needs the model to reach. */
  maxResolution?: number | undefined;
}

/** What the router matches a model on — the typed "capability requirement". */
export interface CapabilityRequirement {
  modality: GenerationModality;
  inputs: GenerationInputType[];
  constraints?: CapabilityConstraints | undefined;
}

export interface SkillTaskKind {
  /** Stable id, e.g. "text-to-image", "image-to-video", "inpaint". */
  id: string;
  label: string;
  modality: GenerationModality;
  inputs: GenerationInputType[];
  /** Live Zod schema for the task params — reflected for planner hints and validated at call time. */
  inputSchema: ZodTypeAny;
  /** Artifact type produced (drives ingestion + timeline landing). */
  outputArtifact: ToolArtifactType;
  /** What a model must satisfy to run this task kind. */
  capabilityReq: CapabilityRequirement;
}

export type SkillCategory = "generation";

export interface Skill {
  id: string;
  name: string;
  /** User-facing one-liner. Always disclosed (Studio + surfaces). */
  summary: string;
  /** Planner-facing one-liner. Always disclosed in the capability prompt. */
  aiSummary: string;
  /** The "how it's done" body. Disclosed on demand when the skill is selected. */
  procedure: string;
  category: SkillCategory;
  taskKinds: SkillTaskKind[];
}

export function getSkillTaskKind(skill: Skill, taskKindId: string): SkillTaskKind | undefined {
  return skill.taskKinds.find((task) => task.id === taskKindId);
}
