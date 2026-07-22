import { buildRenderManifest, type RenderManifest, type RenderQuality } from "@orreris/render-templates";
import {
  scaledEvenDimension,
  toManifestEncodeSettings,
  withExportWindow,
  type ExportSettings,
  type ModuleType,
  type ProjectGraph,
  type SourceAsset
} from "@orreris/shared";
import { HttpError } from "../lib/http";
import { asJson, fromJson } from "../lib/json";
import { prisma } from "../lib/prisma";
import { enqueueRenderJob } from "../lib/renderQueue";
import { saveDerivedAsset } from "./storage.service";

export const mockTrackingData = {
  frames: [
    { frame: 0, x: 540, y: 900, scale: 1.0, rotation: 0, confidence: 0.95 },
    { frame: 30, x: 520, y: 820, scale: 0.85, rotation: -3, confidence: 0.93 },
    { frame: 60, x: 500, y: 740, scale: 0.65, rotation: -5, confidence: 0.91 }
  ]
};

export async function processSourceAsset(input: {
  sourceAssetId: string;
  userId: string;
  moduleType: ModuleType;
  config?: Record<string, unknown>;
}) {
  const source = await prisma.sourceAsset.findFirst({
    where: { id: input.sourceAssetId, userId: input.userId }
  });

  if (!source) {
    throw new HttpError(404, "Source asset not found");
  }

  const outputs =
    input.moduleType === "PERSON_EXTRACTION"
      ? [
          { type: "person_mask", data: { sourceAssetId: source.id, matte: "mock-soft-mask" } },
          { type: "person_cutout", data: { sourceAssetId: source.id, layer: "mock-cutout" } },
          { type: "tracking_data", data: mockTrackingData }
        ]
      : input.moduleType === "BACKGROUND_REMOVAL"
        ? [
            { type: "person_cutout", data: { sourceAssetId: source.id, mode: "transparent" } },
            { type: "background_plate", data: { sourceAssetId: source.id, mode: "removed" } }
          ]
        : [{ type: input.moduleType.toLowerCase(), data: { sourceAssetId: source.id, config: input.config ?? {} } }];

  const derived = [];

  for (const output of outputs) {
    const fileUrl = await saveDerivedAsset(source.id, output.type, output.data);
    derived.push(
      await prisma.derivedAsset.create({
        data: {
          sourceAssetId: source.id,
          type: output.type,
          configHash: hashConfig(input.config ?? {}),
          fileUrl,
          jsonData: asJson(output.data),
          status: "ready"
        }
      })
    );
  }

  await prisma.sourceAsset.update({
    where: { id: source.id },
    data: { status: "ready" }
  });

  return derived;
}

/**
 * Push a freshly-created render job to the queue (bullmq mode; no-op in mock mode). If the queue is
 * unreachable, mark the row failed so it isn't left "queued" with no consumer, then rethrow so the
 * route surfaces the error instead of the export hanging forever.
 */
async function dispatchRenderJob(jobId: string) {
  try {
    await enqueueRenderJob(jobId);
  } catch (error) {
    await prisma.renderJob.updateMany({
      where: { id: jobId, status: "queued" },
      data: { status: "failed", errorMessage: "Could not queue render job (queue unavailable)", progress: 0 }
    });
    throw error;
  }
}

export async function renderPreview(projectId: string, userId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: { template: true }
  });

  if (!project) {
    throw new HttpError(404, "Project not found");
  }

  const manifest = await buildProjectRenderManifest(projectId, userId, "preview");
  const job = await prisma.renderJob.create({
    data: {
      projectId,
      userId,
      type: "preview",
      status: "queued",
      progress: 0,
      manifest: asJson(manifest),
      manifestVersion: manifest.schemaVersion
    }
  });
  await dispatchRenderJob(job.id);

  const updatedProject = await prisma.project.update({
    where: { id: projectId },
    data: {
      status: "draft",
      previewUrl: null
    },
    include: { template: true, sourceAsset: true, renderJobs: { orderBy: { createdAt: "desc" } } }
  });

  return { job, project: updatedProject };
}

export async function renderFinal(projectId: string, userId: string, settings?: ExportSettings) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: { template: true }
  });

  if (!project) {
    throw new HttpError(404, "Project not found");
  }

  const manifest = await buildProjectRenderManifest(projectId, userId, "final", settings);
  if (settings) {
    applyExportSettingsToManifest(manifest, settings);
  }
  const job = await prisma.renderJob.create({
    data: {
      projectId,
      userId,
      type: "final",
      status: "queued",
      progress: 0,
      manifest: asJson(manifest),
      manifestVersion: manifest.schemaVersion
    }
  });
  await dispatchRenderJob(job.id);

  const updatedProject = await prisma.project.update({
    where: { id: projectId },
    data: { status: "draft", finalUrl: null },
    include: { template: true, sourceAsset: true, renderJobs: { orderBy: { createdAt: "desc" } } }
  });

  return { job, project: updatedProject, creditCost: 0 };
}

/**
 * Fold the export window's settings into a final-quality manifest. Resolution scales the composition
 * (Remotion reads width/height/fps/durationInFrames from manifest.output via Root.tsx calculateMetadata),
 * fps re-derives the frame count from the unchanged duration, and encode carries the bitrate/mode the
 * worker's renderMedia applies. Only "final" exports pass settings; preview is untouched.
 */
function applyExportSettingsToManifest(manifest: RenderManifest, settings: ExportSettings) {
  const out = manifest.output;
  if (settings.scale && settings.scale > 0 && settings.scale !== 1) {
    out.width = scaledEvenDimension(out.width, settings.scale);
    out.height = scaledEvenDimension(out.height, settings.scale);
  }
  if (settings.fps && settings.fps > 0 && settings.fps !== out.fps) {
    out.fps = settings.fps;
    out.durationInFrames = Math.max(1, Math.round(out.durationSeconds * settings.fps));
  }
  out.encode = toManifestEncodeSettings(settings);
}

export async function buildProjectRenderManifest(
  projectId: string,
  userId: string,
  quality: RenderQuality,
  windowSettings?: Pick<ExportSettings, "range" | "trimTrailingBlack">
): Promise<RenderManifest> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId }
  });

  if (!project) {
    throw new HttpError(404, "Project not found");
  }

  const rawGraph = fromJson<ProjectGraph>(project.projectGraph);
  // Apply the export window (Full vs In/Out + safe-timeline trim) by stamping In/Out onto the
  // composition BEFORE buildRenderManifest, which clips to those points — so cloud honors the same
  // range/trim choices as the local export (both read the same in/out machinery).
  const graph =
    windowSettings && rawGraph.composition
      ? { ...rawGraph, composition: withExportWindow(rawGraph.composition, windowSettings) }
      : rawGraph;
  const assets: SourceAsset[] = (await prisma.sourceAsset.findMany({ where: { userId } })).map((asset) => ({
    id: asset.id,
    userId: asset.userId,
    fileName: asset.fileName,
    fileType: asset.fileType,
    fileUrl: asset.fileUrl,
    durationSeconds: asset.durationSeconds,
    width: asset.width,
    height: asset.height,
    status: sourceAssetStatus(asset.status),
    createdAt: asset.createdAt.toISOString()
  }));

  return buildRenderManifest({
    projectId,
    graph,
    assets,
    quality
  });
}

function sourceAssetStatus(status: string): SourceAsset["status"] {
  return status === "processing" || status === "ready" || status === "failed" || status === "uploaded" ? status : "uploaded";
}

function hashConfig(config: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(config)).toString("base64url").slice(0, 24) || "default";
}
