import {
  getGenerationModel,
  resolveBestModel,
  type GenerationAvailability,
  type GenerationModel,
  type GenerationPref,
  type ResolveTask
} from "@kimera-by-aelivion/shared";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { saveBuffer } from "./storage.service";
import { recordUsage } from "./usageLedger.service";

/**
 * Cloud generation router — the server-side half of the "which model is capable" flow.
 *
 * Mirrors the multi-provider text gateway (`aiGateway.service.ts`): the fal.ai key is held
 * here, never sent to the browser. The route resolves a capable+available model via the
 * shared registry, then this service submits to fal's queue, polls, downloads the result,
 * and ingests it as a SourceAsset(source="ai"). Cost is metadata only (no gating).
 */

export function falConfigured(): boolean {
  return Boolean(env.FAL_KEY);
}

/** Availability the *server* knows about. The web client merges its local-endpoint probe on top. */
export function serverAvailability(): GenerationAvailability {
  return { falKey: falConfigured(), localEndpoint: false, byoKey: false };
}

/** Resolve a cloud model for a task, honoring an explicit modelId when the client picked one. */
export function resolveCloudModel(
  task: ResolveTask,
  modelId: string | undefined,
  pref: GenerationPref
): GenerationModel | undefined {
  if (modelId) {
    const picked = getGenerationModel(modelId);
    // Only honor an explicit pick if it's a cloud model that's actually available.
    if (picked && picked.provider !== "local" && picked.availabilityReq === "falKey" && falConfigured()) {
      return picked;
    }
    return undefined;
  }
  const best = resolveBestModel(task, serverAvailability(), pref);
  return best?.model;
}

interface FalSubmitResponse {
  request_id?: string;
  response_url?: string;
  status_url?: string;
}

interface FalStatusResponse {
  status?: string;
}

interface GeneratedMedia {
  url: string;
  width?: number | undefined;
  height?: number | undefined;
  contentType?: string | undefined;
  seed?: number | undefined;
}

const FAL_POLL_INTERVAL_MS = 2_000;
const FAL_MAX_WAIT_MS = 5 * 60_000; // video can take minutes

async function falFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Key ${env.FAL_KEY ?? ""}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
}

/**
 * Pull a human-readable reason out of a failed fal response. fal returns JSON like
 * `{"detail":"..."}` or `{"detail":[{"msg":"..."}]}`; we surface it so the job's
 * errorMessage explains *why* (e.g. billing not enabled, model requires acceptance)
 * instead of a bare status code.
 */
async function falErrorDetail(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; message?: unknown; error?: unknown };
    const detail = parsed.detail ?? parsed.message ?? parsed.error;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const msgs = detail
        .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : ""))
        .filter(Boolean);
      if (msgs.length) return msgs.join("; ");
    }
    return raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}

/**
 * Map skill task params onto fal input. Field names are provider-specific and vary by model
 * family; this covers the seeded FLUX/LTX/Kling entries and defaults sanely for others.
 */
function buildFalInput(model: GenerationModel, taskKind: string, params: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (typeof params.prompt === "string" && params.prompt) input.prompt = params.prompt;
  if (typeof params.negativePrompt === "string" && params.negativePrompt) input.negative_prompt = params.negativePrompt;
  if (typeof params.seed === "number") input.seed = params.seed;
  if (typeof params.referenceImage === "string" && params.referenceImage) input.image_url = params.referenceImage;
  if (typeof params.mask === "string" && params.mask) input.mask_url = params.mask;
  if (typeof params.strength === "number") input.strength = params.strength;

  const aspect = typeof params.aspectRatio === "string" ? params.aspectRatio : undefined;
  if (aspect) {
    if (model.modalities.includes("video")) {
      input.aspect_ratio = aspect; // Kling/LTX accept "16:9"|"9:16"|"1:1"
    } else {
      input.image_size = falImageSize(aspect); // FLUX accepts an enum
    }
  }

  if (model.modalities.includes("video") && typeof params.durationSeconds === "number") {
    input.duration = String(Math.round(params.durationSeconds)); // Kling wants "5"|"10"
  }

  if (taskKind === "upscale" && typeof params.scale === "string") {
    input.scale = params.scale === "4x" ? 4 : 2;
  }

  return input;
}

function falImageSize(aspect: string): string {
  switch (aspect) {
    case "16:9":
      return "landscape_16_9";
    case "9:16":
      return "portrait_9_16";
    case "4:3":
      return "landscape_4_3";
    case "3:4":
      return "portrait_4_3";
    default:
      return "square_hd";
  }
}

/** Pull the first image/video URL + dims out of fal's (model-varying) result shape. */
function extractMedia(result: unknown): GeneratedMedia | undefined {
  const obj = (result ?? {}) as Record<string, unknown>;
  const images = obj.images as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(images) && images[0]?.url) {
    const first = images[0]!;
    return {
      url: String(first.url),
      width: typeof first.width === "number" ? first.width : undefined,
      height: typeof first.height === "number" ? first.height : undefined,
      contentType: typeof first.content_type === "string" ? first.content_type : undefined,
      seed: typeof obj.seed === "number" ? obj.seed : undefined
    };
  }
  const image = obj.image as Record<string, unknown> | undefined;
  if (image?.url) {
    return { url: String(image.url), contentType: typeof image.content_type === "string" ? image.content_type : undefined };
  }
  const video = obj.video as Record<string, unknown> | undefined;
  if (video?.url) {
    return { url: String(video.url), contentType: typeof video.content_type === "string" ? video.content_type : undefined };
  }
  return undefined;
}

async function runFalGeneration(
  model: GenerationModel,
  taskKind: string,
  params: Record<string, unknown>,
  onProgress?: (progress: number) => void
): Promise<GeneratedMedia> {
  const submitUrl = `${env.FAL_QUEUE_BASE_URL}/${model.providerModelId}`;
  const submit = await falFetch(submitUrl, { method: "POST", body: JSON.stringify(buildFalInput(model, taskKind, params)) });
  if (!submit.ok) {
    const detail = await falErrorDetail(submit);
    const hint =
      submit.status === 403
        ? " — fal rejected the request. Usually this means the account has no billing/credits enabled, or the API key lacks access to this model. Add a payment method at fal.ai/dashboard/billing and confirm the key at fal.ai/dashboard/keys."
        : submit.status === 401
          ? " — the FAL_KEY was not accepted (check for a stray space or a partial key; fal keys look like `id:secret`)."
          : "";
    throw new Error(`fal submit failed (${submit.status})${detail ? `: ${detail}` : ""}${hint}`);
  }
  const queued = (await submit.json()) as FalSubmitResponse;
  const statusUrl = queued.status_url;
  const responseUrl = queued.response_url;
  if (!statusUrl || !responseUrl) {
    throw new Error("fal did not return a queue handle");
  }

  const startedAt = Date.now();
  onProgress?.(5);
  for (;;) {
    if (Date.now() - startedAt > FAL_MAX_WAIT_MS) {
      throw new Error("fal generation timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, FAL_POLL_INTERVAL_MS));
    const statusRes = await falFetch(statusUrl);
    if (!statusRes.ok) {
      const detail = await falErrorDetail(statusRes);
      throw new Error(`fal status failed (${statusRes.status})${detail ? `: ${detail}` : ""}`);
    }
    const status = ((await statusRes.json()) as FalStatusResponse).status ?? "";
    if (status === "COMPLETED") {
      onProgress?.(90);
      break;
    }
    onProgress?.(status === "IN_PROGRESS" ? 60 : 25);
  }

  const resultRes = await falFetch(responseUrl);
  if (!resultRes.ok) {
    const detail = await falErrorDetail(resultRes);
    throw new Error(`fal result failed (${resultRes.status})${detail ? `: ${detail}` : ""}`);
  }
  const media = extractMedia(await resultRes.json());
  if (!media) {
    throw new Error("fal result had no image/video url");
  }
  return media;
}

function aspectToDims(aspectRatio: string | undefined, longEdge: number): { width: number; height: number } {
  const parts = (aspectRatio ?? "1:1").split(":");
  const w = Number(parts[0]) || 1;
  const h = Number(parts[1]) || 1;
  if (w >= h) {
    return { width: longEdge, height: Math.round((longEdge * h) / w) };
  }
  return { width: Math.round((longEdge * w) / h), height: longEdge };
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`download failed (${res.status})`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a queued GenerationJob to completion in the background. Fire-and-forget from the
 * route; the client polls GET /api/generate/:id. (BullMQ is the durable-scale path later —
 * the worker already defaults to inline execution, so in-process is correct for the MVP.)
 */
export async function processGenerationJob(jobId: string): Promise<void> {
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return;
  }
  const model = getGenerationModel(job.modelId);
  if (!model || model.provider === "local") {
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: "failed", errorMessage: "No runnable cloud model for this job" }
    });
    return;
  }

  const params = (job.params ?? {}) as Record<string, unknown>;
  const isVideo = model.modalities.includes("video");

  try {
    await prisma.generationJob.update({ where: { id: jobId }, data: { status: "running", progress: 5 } });

    const media = await runFalGeneration(model, job.taskKind, params, async (progress) => {
      await prisma.generationJob.update({ where: { id: jobId }, data: { progress } }).catch(() => undefined);
    });

    const buffer = await downloadToBuffer(media.url);
    const ext = isVideo ? "mp4" : media.contentType?.includes("png") ? "png" : "jpg";
    const fileName = `ai-${job.taskKind}-${jobId}.${ext}`;
    const fileUrl = await saveBuffer(buffer, fileName);

    const longEdge = isVideo ? Math.min(model.constraints.maxResolution ?? 1080, 1080) : model.constraints.maxResolution ?? 1024;
    const aspect = typeof params.aspectRatio === "string" ? params.aspectRatio : undefined;
    const dims =
      media.width && media.height
        ? { width: media.width, height: media.height }
        : aspectToDims(aspect, longEdge);

    const durationSeconds = isVideo
      ? Math.max(1, Math.ceil(typeof params.durationSeconds === "number" ? params.durationSeconds : 5))
      : 5;

    const asset = await prisma.sourceAsset.create({
      data: {
        userId: job.userId,
        fileName,
        fileType: isVideo ? "video/mp4" : media.contentType ?? "image/jpeg",
        fileUrl,
        cloudUrl: fileUrl,
        durationSeconds,
        width: dims.width,
        height: dims.height,
        status: "ready",
        source: "ai",
        folder: `ai/${job.taskKind}`,
        originalName: typeof params.prompt === "string" ? String(params.prompt).slice(0, 120) : job.taskKind,
        // AI assets are user-level & reusable (ownerProjectId stays null); link to the generating project so
        // they show in its bin without being bound to it.
        ...(job.projectId ? { projectLinks: { create: { projectId: job.projectId } } } : {}),
        sizeBytes: buffer.byteLength,
        aiJson: {
          model: model.id,
          prompt: typeof params.prompt === "string" ? params.prompt : undefined,
          seed: media.seed !== undefined ? String(media.seed) : typeof params.seed === "number" ? String(params.seed) : undefined
        }
      }
    });

    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: "completed", progress: 100, resultAssetId: asset.id }
    });

    // Phase 0 shadow-billing: record what this generation would have cost — telemetry only,
    // never gates and never touches user.walletCredits. See billing/pricing.ts.
    void recordUsage({
      userId: job.userId,
      action: `generate.${job.taskKind}`,
      units: isVideo ? durationSeconds : 1,
      provider: model.provider
    });
  } catch (error) {
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: "failed", errorMessage: error instanceof Error ? error.message : "generation failed" }
    });
  }
}
