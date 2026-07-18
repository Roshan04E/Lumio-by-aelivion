import { Router } from "express";
import { moduleCatalog, mvpLimits, toPublicModule, toolDefinitions, type SourceAsset } from "@orreris/shared";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { asyncHandler, getParam, HttpError, ok } from "../lib/http";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { suggestHighlightWordsWithGemini, transcribeWithGemini, transformCaptionsWithGemini } from "../services/geminiTranscription.service";
import { recordUsage } from "../services/usageLedger.service";

export const toolsRouter = Router();

type AutoCaptionJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

interface AutoCaptionJobRecord {
  id: string;
  userId: string;
  status: AutoCaptionJobStatus;
  progress: number;
  message: string;
  result?: Awaited<ReturnType<typeof transcribeWithGemini>> | undefined;
  errorMessage?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

const autoCaptionJobs = new Map<string, AutoCaptionJobRecord>();

const autoCaptionTranscribeSchema = z.object({
  assetId: z.string().min(1),
  language: z.enum(["auto", "english", "hindi", "hinglish"]).default("hinglish"),
  stylePresetId: z.string().min(1).default("punchy-center"),
  highlightedWords: z.string().default(""),
  prompt: z.string().max(8000).optional()
});

const autoCaptionTransformSchema = z.object({
  action: z.enum(["repair", "improve"]),
  transcriptText: z.string().min(1).max(80_000),
  language: z.enum(["auto", "english", "hindi", "hinglish"]).default("hinglish"),
  durationSeconds: z.coerce.number().min(0).max(7200).optional(),
  styleGoal: z.string().max(400).optional(),
  highlightedWords: z.string().max(1000).optional()
});

const autoCaptionHighlightsSchema = z.object({
  transcriptText: z.string().min(1).max(80_000),
  language: z.enum(["auto", "english", "hindi", "hinglish"]).default("hinglish")
});

toolsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const tools = await prisma.tool.findMany({
      where: { active: true },
      orderBy: { name: "asc" }
    });

    return ok(res, "Tools", {
      tools: tools.length ? tools : toolDefinitions,
      modules: moduleCatalog.map(toPublicModule),
      limits: mvpLimits
    });
  })
);

toolsRouter.post(
  "/auto-captions/transform",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = autoCaptionTransformSchema.parse(req.body);
    const transcript = await transformCaptionsWithGemini(input);

    return ok(res, input.action === "repair" ? "Transcript repaired" : "Captions improved", {
      transcript,
      provider: "gemini"
    });
  })
);

toolsRouter.post(
  "/auto-captions/highlights",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = autoCaptionHighlightsSchema.parse(req.body);
    const words = await suggestHighlightWordsWithGemini(input);

    return ok(res, "Highlight words suggested", { words, provider: "gemini" });
  })
);

toolsRouter.post(
  "/auto-captions/transcribe",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = autoCaptionTranscribeSchema.parse(req.body);
    const asset = await prisma.sourceAsset.findFirst({
      where: {
        id: input.assetId,
        userId: req.user.id
      }
    });

    if (!asset) {
      return res.status(404).json({
        success: false,
        message: "Asset not found",
        data: null
      });
    }

    const now = new Date().toISOString();
    const job: AutoCaptionJobRecord = {
      id: `caption_job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: req.user.id,
      status: "queued",
      progress: 2,
      message: "Queued Gemini transcription.",
      createdAt: now,
      updatedAt: now
    };
    autoCaptionJobs.set(job.id, job);

    void runAutoCaptionJob(job.id, {
      asset: toSourceAsset(asset),
      language: input.language,
      stylePresetId: input.stylePresetId,
      highlightedWords: input.highlightedWords,
      prompt: input.prompt
    });

    return ok(res, "Gemini transcription queued", { job: toPublicAutoCaptionJob(job) }, 202);
  })
);

toolsRouter.get(
  "/auto-captions/transcribe/:jobId",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const job = autoCaptionJobs.get(getParam(req, "jobId"));
    if (!job || job.userId !== req.user.id) {
      throw new HttpError(404, "Transcription job not found");
    }

    return ok(res, "Gemini transcription job", { job: toPublicAutoCaptionJob(job) });
  })
);

toolsRouter.post(
  "/auto-captions/transcribe/:jobId/cancel",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const job = autoCaptionJobs.get(getParam(req, "jobId"));
    if (!job || job.userId !== req.user.id) {
      throw new HttpError(404, "Transcription job not found");
    }
    if (job.status === "completed") {
      throw new HttpError(409, "Completed transcription jobs cannot be cancelled");
    }

    updateAutoCaptionJob(job.id, {
      status: "cancelled",
      progress: 0,
      message: "Gemini transcription cancelled."
    });

    return ok(res, "Gemini transcription cancelled", { job: toPublicAutoCaptionJob(autoCaptionJobs.get(job.id)!) });
  })
);

async function runAutoCaptionJob(
  jobId: string,
  input: Parameters<typeof transcribeWithGemini>[0]
) {
  try {
    updateAutoCaptionJob(jobId, { status: "processing", progress: 12, message: "Preparing media for Gemini." });
    await sleep(150);
    updateAutoCaptionJob(jobId, { status: "processing", progress: 28, message: "Uploading media to Gemini." });
    const result = await transcribeWithGemini(input);

    const current = autoCaptionJobs.get(jobId);
    if (current?.status === "cancelled") {
      return;
    }

    // Phase 0 shadow-billing: record what this cloud transcription would have cost — telemetry
    // only, never gates and never touches user.walletCredits. See billing/pricing.ts.
    if (current) {
      void recordUsage({
        userId: current.userId,
        action: "caption.cloud-transcribe",
        units: input.asset.durationSeconds / 60,
        provider: result.provider
      });
    }

    updateAutoCaptionJob(jobId, { status: "processing", progress: 88, message: "Saving transcript artifacts." });
    await Promise.all([
      prisma.derivedAsset.create({
        data: {
          sourceAssetId: input.asset.id,
          type: "caption_data",
          configHash: `gemini-transcript-${Date.now()}`,
          jsonData: toJsonValue({
            provider: result.provider,
            model: result.model,
            transcript: result.transcript
          }),
          status: "ready"
        }
      }),
      prisma.derivedAsset.create({
        data: {
          sourceAssetId: input.asset.id,
          type: "caption_data",
          configHash: `gemini-caption-track-${Date.now()}`,
          jsonData: toJsonValue({
            provider: result.provider,
            model: result.model,
            captionTrack: result.captionTrack,
            captionInterchangeArtifact: result.captionInterchangeArtifact
          }),
          status: "ready"
        }
      })
    ]);

    updateAutoCaptionJob(jobId, {
      status: "completed",
      progress: 100,
      message: `Gemini transcript ready with ${result.transcript.segments.length} segments.`,
      result
    });
  } catch (error) {
    const current = autoCaptionJobs.get(jobId);
    if (current?.status === "cancelled") {
      return;
    }
    updateAutoCaptionJob(jobId, {
      status: "failed",
      progress: 0,
      message: "Gemini transcription failed.",
      errorMessage: error instanceof Error ? error.message : "Gemini transcription failed."
    });
  }
}

function updateAutoCaptionJob(jobId: string, patch: Partial<AutoCaptionJobRecord>) {
  const current = autoCaptionJobs.get(jobId);
  if (!current) {
    return;
  }
  autoCaptionJobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function toPublicAutoCaptionJob(job: AutoCaptionJobRecord) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result
      ? {
          transcript: job.result.transcript,
          captionTrack: job.result.captionTrack,
          captionInterchangeArtifact: job.result.captionInterchangeArtifact,
          provider: job.result.provider,
          model: job.result.model
        }
      : undefined
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSourceAsset(asset: {
  id: string;
  userId: string;
  fileName: string;
  fileType: string;
  fileUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  status: string;
  createdAt: Date;
}): SourceAsset {
  return {
    ...asset,
    status: isSourceAssetStatus(asset.status) ? asset.status : "uploaded",
    createdAt: asset.createdAt.toISOString()
  };
}

function isSourceAssetStatus(value: string): value is SourceAsset["status"] {
  return value === "uploaded" || value === "processing" || value === "ready" || value === "failed";
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
