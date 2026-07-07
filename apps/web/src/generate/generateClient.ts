import {
  getSkill,
  getSkillTaskKind,
  resolveBestModel,
  resolveModels,
  type CapabilityConstraints,
  type GenerationAvailability,
  type GenerationPref,
  type RankedModel,
  type ResolveTask,
  type SourceAsset
} from "@lumio-by-aelivion/shared";
import { apiRequest, createAsset } from "../lib/api";
import { generateLocalImage, loadLocalGenConfig, pingLocalGen } from "./localGen";

/**
 * Client-side generation orchestrator — the surface the Studio and (later) the chat plan step call.
 *
 * It resolves the best capable+available model via the shared registry, then dispatches:
 *   - local models run browser-direct (free, private) and the result is ingested as a
 *     SourceAsset(source="ai") via the normal asset upload path;
 *   - cloud models are queued on the API (`POST /api/generate`) and polled to completion.
 * Either way the caller gets back a SourceAsset that already lives in the media bin's AI tab.
 */

export interface GenerationJobDto {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  skillId: string;
  taskKind: string;
  provider: string;
  modelId: string;
  resultAssetId?: string | undefined;
  error?: string | undefined;
  createdAt: string;
}

export interface GenerationRequestInput {
  skillId: string;
  taskKind: string;
  params: Record<string, unknown>;
  pref?: GenerationPref | undefined;
  projectId?: string | undefined;
  /** Force a specific model id (from the picker). Omit to auto-resolve. */
  modelId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface GenerationOutcome {
  asset: SourceAsset;
  modelId: string;
  provider: string;
  tier: "browser" | "cloud";
}

async function serverAvailability(): Promise<{ falKey: boolean; byoKey: boolean }> {
  try {
    return await apiRequest<{ falKey: boolean; byoKey: boolean }>("/generate/availability");
  } catch {
    return { falKey: false, byoKey: false };
  }
}

/** Combined availability: server key presence + a live local-endpoint probe. */
export async function getGenerationAvailability(): Promise<GenerationAvailability> {
  const server = await serverAvailability();
  const local = loadLocalGenConfig();
  const localEndpoint = local?.enabled ? await pingLocalGen(local.baseUrl, local.backend) : false;
  return { falKey: server.falKey, byoKey: server.byoKey, localEndpoint };
}

function constraintsFromParams(params: Record<string, unknown>): CapabilityConstraints | undefined {
  const constraints: CapabilityConstraints = {};
  if (typeof params.durationSeconds === "number") constraints.maxDurationSeconds = params.durationSeconds;
  if (typeof params.aspectRatio === "string") constraints.aspectRatios = [params.aspectRatio];
  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

function resolveTaskFor(skillId: string, taskKind: string, params: Record<string, unknown>): ResolveTask {
  const skill = getSkill(skillId);
  const task = skill ? getSkillTaskKind(skill, taskKind) : undefined;
  if (!skill || !task) {
    throw new Error(`Unknown skill/task: ${skillId}/${taskKind}`);
  }
  return {
    taskKind: task.id,
    modality: task.modality,
    inputs: task.inputs,
    constraints: constraintsFromParams(params)
  };
}

/** Models capable of this task under the given availability (for the Studio's model picker). */
export function rankModelsForTask(
  skillId: string,
  taskKind: string,
  params: Record<string, unknown>,
  availability: GenerationAvailability,
  pref: GenerationPref = "localFirst"
): RankedModel[] {
  return resolveModels(resolveTaskFor(skillId, taskKind, params), availability, pref);
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 6 * 60_000;

export async function runGeneration(
  input: GenerationRequestInput,
  onProgress?: (progress: number, note: string) => void
): Promise<GenerationOutcome> {
  const skill = getSkill(input.skillId);
  const task = skill ? getSkillTaskKind(skill, input.taskKind) : undefined;
  if (!skill || !task) {
    throw new Error(`Unknown skill/task: ${input.skillId}/${input.taskKind}`);
  }

  const parsed = task.inputSchema.safeParse(input.params);
  if (!parsed.success) {
    const issue = parsed.error.issues.at(0);
    throw new Error(issue ? `${issue.path.join(".") || "params"}: ${issue.message}` : "Invalid generation params");
  }
  const params = parsed.data as Record<string, unknown>;

  const availability = await getGenerationAvailability();
  const pref = input.pref ?? "localFirst";
  const resolveTask = resolveTaskFor(input.skillId, input.taskKind, params);

  // Honor an explicit pick when it's still capable+available; else auto-resolve.
  const ranked = resolveModels(resolveTask, availability, pref);
  const chosen = input.modelId ? ranked.find((r) => r.model.id === input.modelId) ?? ranked[0] : ranked[0];
  if (!chosen) {
    throw new Error(
      "No generator is available for this task. Connect a local Stable Diffusion server (image), or add a cloud key on the server."
    );
  }
  const model = chosen.model;

  if (model.provider === "local") {
    onProgress?.(10, "Generating on your machine…");
    const config = loadLocalGenConfig();
    if (!config) {
      throw new Error("Local generation is not configured.");
    }
    const result = await generateLocalImage({
      baseUrl: config.baseUrl,
      backend: config.backend,
      model: config.model || undefined,
      taskKind: task.id,
      params: {
        prompt: typeof params.prompt === "string" ? params.prompt : "",
        negativePrompt: typeof params.negativePrompt === "string" ? params.negativePrompt : undefined,
        aspectRatio: typeof params.aspectRatio === "string" ? params.aspectRatio : undefined,
        seed: typeof params.seed === "number" ? params.seed : undefined,
        referenceImage: typeof params.referenceImage === "string" ? params.referenceImage : undefined,
        mask: typeof params.mask === "string" ? params.mask : undefined,
        strength: typeof params.strength === "number" ? params.strength : undefined
      },
      signal: input.signal
    });

    onProgress?.(80, "Saving to your media bin…");
    const blob = await (await fetch(result.dataUrl)).blob();
    const file = new File([blob], `ai-${task.id}-${Date.now()}.png`, { type: "image/png" });
    const prompt = typeof params.prompt === "string" ? params.prompt : undefined;
    const asset = await createAsset({
      file,
      source: "ai",
      folder: `ai/${task.id}`,
      fileType: "image/png",
      width: result.width,
      height: result.height,
      durationSeconds: 5,
      sizeBytes: blob.size,
      originalName: prompt ? prompt.slice(0, 120) : task.label,
      projectId: input.projectId,
      ai: {
        model: model.id,
        prompt,
        seed: typeof params.seed === "number" ? String(params.seed) : undefined
      }
    });
    onProgress?.(100, "Done");
    return { asset, modelId: model.id, provider: model.provider, tier: "browser" };
  }

  // Cloud: queue on the API and poll to completion.
  onProgress?.(5, "Queued on the cloud…");
  const created = await apiRequest<{ job: GenerationJobDto }>("/generate", {
    method: "POST",
    body: JSON.stringify({
      skillId: input.skillId,
      taskKind: input.taskKind,
      params,
      pref,
      modelId: model.id,
      projectId: input.projectId
    })
  });

  const startedAt = Date.now();
  let jobId = created.job.id;
  for (;;) {
    if (input.signal?.aborted) {
      throw new Error("Generation cancelled");
    }
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error("Generation timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const polled = await apiRequest<{ job: GenerationJobDto; asset?: SourceAsset }>(`/generate/${jobId}`);
    jobId = polled.job.id;
    onProgress?.(Math.max(5, polled.job.progress), polled.job.status === "running" ? "Generating…" : polled.job.status);
    if (polled.job.status === "completed" && polled.asset) {
      onProgress?.(100, "Done");
      return { asset: polled.asset, modelId: model.id, provider: model.provider, tier: "cloud" };
    }
    if (polled.job.status === "failed") {
      throw new Error(polled.job.error ?? "Generation failed");
    }
  }
}
