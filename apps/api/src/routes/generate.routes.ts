import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  getSkill,
  getSkillTaskKind,
  type CapabilityConstraints,
  type GenerationPref,
  type ResolveTask
} from "@kimera-by-aelivion/shared";
import { asyncHandler, getParam, HttpError, ok, validateBody } from "../lib/http";
import { prisma } from "../lib/prisma";
import { serializeAsset } from "../lib/asset-serializer";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import {
  processGenerationJob,
  resolveCloudModel,
  serverAvailability
} from "../services/generationRouter.service";

export const generateRouter = Router();

/** Server-known availability. The web client merges its local-endpoint probe on top of this. */
generateRouter.get(
  "/availability",
  requireAuth,
  asyncHandler<AuthRequest>(async (_req, res) => {
    const availability = serverAvailability();
    return ok(res, "Generation availability", { falKey: availability.falKey, byoKey: availability.byoKey });
  })
);

const createSchema = z.object({
  skillId: z.string().min(1),
  taskKind: z.string().min(1),
  params: z.record(z.unknown()),
  pref: z.enum(["localFirst", "quality", "speed"]).default("quality"),
  modelId: z.string().optional(),
  projectId: z.string().optional()
});

function serializeJob(job: {
  id: string;
  status: string;
  progress: number;
  skillId: string;
  taskKind: string;
  provider: string;
  modelId: string;
  resultAssetId: string | null;
  errorMessage: string | null;
  createdAt: Date;
}) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    skillId: job.skillId,
    taskKind: job.taskKind,
    provider: job.provider,
    modelId: job.modelId,
    resultAssetId: job.resultAssetId ?? undefined,
    error: job.errorMessage ?? undefined,
    createdAt: job.createdAt.toISOString()
  };
}

/** Build the runtime capability constraints a request places on a model, from its params. */
function constraintsFromParams(params: Record<string, unknown>): CapabilityConstraints | undefined {
  const constraints: CapabilityConstraints = {};
  if (typeof params.durationSeconds === "number") constraints.maxDurationSeconds = params.durationSeconds;
  if (typeof params.aspectRatio === "string") constraints.aspectRatios = [params.aspectRatio];
  return Object.keys(constraints).length > 0 ? constraints : undefined;
}

generateRouter.post(
  "/",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = validateBody(createSchema, req.body);

    const skill = getSkill(input.skillId);
    if (!skill) {
      throw new HttpError(404, `Unknown skill: ${input.skillId}`);
    }
    const task = getSkillTaskKind(skill, input.taskKind);
    if (!task) {
      throw new HttpError(404, `Unknown task kind: ${input.taskKind}`);
    }

    // Validate the params against the task's live schema (defaults applied).
    const parsedParams = task.inputSchema.safeParse(input.params);
    if (!parsedParams.success) {
      const issue = parsedParams.error.issues.at(0);
      throw new HttpError(400, issue ? `${issue.path.join(".") || "params"}: ${issue.message}` : "Invalid generation params");
    }
    const params = parsedParams.data as Record<string, unknown>;

    const resolveTask: ResolveTask = {
      taskKind: task.id,
      modality: task.modality,
      inputs: task.inputs,
      constraints: constraintsFromParams(params)
    };

    const model = resolveCloudModel(resolveTask, input.modelId, input.pref as GenerationPref);
    if (!model) {
      // No capable+available cloud model — the client falls back to a local route when it has one.
      throw new HttpError(
        501,
        "No cloud model is available for this task. Add FAL_KEY on the server, or use a local generator for image tasks."
      );
    }

    const job = await prisma.generationJob.create({
      data: {
        userId: req.user.id,
        projectId: input.projectId ?? null,
        skillId: skill.id,
        taskKind: task.id,
        provider: model.provider,
        modelId: model.id,
        params: params as Prisma.InputJsonObject,
        status: "queued",
        progress: 0
      }
    });

    // Run in the background; the client polls GET /api/generate/:id.
    void processGenerationJob(job.id);

    return ok(res, "Generation queued", { job: serializeJob(job) }, 201);
  })
);

generateRouter.get(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const job = await prisma.generationJob.findFirst({ where: { id, userId: req.user.id } });
    if (!job) {
      throw new HttpError(404, "Generation job not found");
    }
    const asset = job.resultAssetId
      ? await prisma.sourceAsset.findUnique({ where: { id: job.resultAssetId } })
      : null;
    return ok(res, "Generation job", {
      job: serializeJob(job),
      asset: asset ? serializeAsset(asset) : undefined
    });
  })
);
