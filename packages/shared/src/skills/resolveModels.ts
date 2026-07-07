import { modelCapabilityRegistry, type GenerationModel } from "./model-registry";
import type { CapabilityConstraints, GenerationInputType, GenerationModality } from "./skill-types";

/**
 * The "which model is capable" resolver.
 *
 * Given a concrete task (a skill task kind + its inputs/constraints), the current
 * availability (fal key present? local endpoint reachable? BYO key?), and a user
 * preference, return the capable-AND-available models ranked best-first. An empty
 * result means "nothing here can do this right now" — the caller surfaces that
 * (e.g. "connect a local generator or add a cloud key").
 *
 * This is what makes local-vs-cloud automatic instead of hardcoded: an image task
 * with a reachable local endpoint ranks the free local model first; a video task has
 * no local candidate, so it resolves to cloud on its own.
 */

/** Runtime availability flags. `localEndpoint` is web-side (probe); the others are key presence. */
export interface GenerationAvailability {
  falKey: boolean;
  localEndpoint: boolean;
  byoKey: boolean;
}

export type GenerationPref = "localFirst" | "quality" | "speed";

export interface ResolveTask {
  taskKind: string;
  modality: GenerationModality;
  inputs: GenerationInputType[];
  constraints?: CapabilityConstraints | undefined;
}

export interface RankedModel {
  model: GenerationModel;
  score: number;
  reason: string;
}

function isAvailable(model: GenerationModel, availability: GenerationAvailability): boolean {
  switch (model.availabilityReq) {
    case "falKey":
      return availability.falKey;
    case "localEndpoint":
      return availability.localEndpoint;
    case "byoKey":
      return availability.byoKey;
    default:
      return false;
  }
}

function satisfiesConstraints(model: GenerationModel, needed?: CapabilityConstraints): boolean {
  if (!needed) {
    return true;
  }
  const have = model.constraints;
  if (needed.maxDurationSeconds !== undefined) {
    if (have.maxDurationSeconds === undefined || have.maxDurationSeconds < needed.maxDurationSeconds) {
      return false;
    }
  }
  if (needed.maxResolution !== undefined) {
    if (have.maxResolution === undefined || have.maxResolution < needed.maxResolution) {
      return false;
    }
  }
  if (needed.aspectRatios && needed.aspectRatios.length > 0) {
    const supported = have.aspectRatios ?? [];
    if (!needed.aspectRatios.every((ratio) => supported.includes(ratio))) {
      return false;
    }
  }
  return true;
}

/** A model must support every input the task carries (task.inputs ⊆ model.inputs). */
function supportsInputs(model: GenerationModel, taskInputs: GenerationInputType[]): boolean {
  return taskInputs.every((input) => model.inputs.includes(input));
}

function isCapable(model: GenerationModel, task: ResolveTask): boolean {
  return (
    model.taskKinds.includes(task.taskKind) &&
    model.modalities.includes(task.modality) &&
    supportsInputs(model, task.inputs) &&
    satisfiesConstraints(model, task.constraints)
  );
}

function scoreModel(model: GenerationModel, pref: GenerationPref): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  // Local-first bias: free local work is preferred unless the user explicitly optimizes otherwise.
  if (model.provider === "local") {
    const bonus = pref === "localFirst" ? 100 : 40;
    score += bonus;
    reasons.push("local/free");
  }

  if (pref === "quality") {
    const q = model.qualityTier === "high" ? 60 : model.qualityTier === "standard" ? 30 : 0;
    score += q;
    if (q > 0) reasons.push(`${model.qualityTier} quality`);
  } else if (pref === "speed") {
    const s = model.latencyClass === "fast" ? 60 : model.latencyClass === "medium" ? 25 : 0;
    score += s;
    if (s > 0) reasons.push(`${model.latencyClass} latency`);
  }

  // Cheaper is a mild tiebreak (metadata cost, not a gate).
  score += Math.max(0, 20 - model.cost);

  return { score, reason: reasons.join(", ") || model.label };
}

export function resolveModels(
  task: ResolveTask,
  availability: GenerationAvailability,
  pref: GenerationPref = "localFirst"
): RankedModel[] {
  return modelCapabilityRegistry
    .filter((model) => isCapable(model, task) && isAvailable(model, availability))
    .map((model) => {
      const { score, reason } = scoreModel(model, pref);
      return { model, score, reason };
    })
    .sort((a, b) => b.score - a.score || a.model.cost - b.model.cost);
}

/** Convenience: the single best model, or undefined when nothing is capable+available. */
export function resolveBestModel(
  task: ResolveTask,
  availability: GenerationAvailability,
  pref: GenerationPref = "localFirst"
): RankedModel | undefined {
  return resolveModels(task, availability, pref)[0];
}
