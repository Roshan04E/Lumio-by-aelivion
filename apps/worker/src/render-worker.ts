import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { buildRenderManifest, type RenderManifest } from "@lumio-by-aelivion/render-templates";
import { type ProjectGraph, type SourceAsset } from "@lumio-by-aelivion/shared";
import { makeCancelSignal } from "@remotion/renderer";
import { renderManifestToMp4 } from "./remotion-renderer";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(workerRoot, "../..");

dotenv.config({ path: path.join(workspaceRoot, ".env") });
dotenv.config({ path: path.join(workspaceRoot, ".env.local"), override: true });
dotenv.config({ path: path.join(workerRoot, ".env") });
dotenv.config({ path: path.join(workerRoot, ".env.local"), override: true });

process.env.DATABASE_URL ??= "postgresql://lumio:lumio@localhost:5432/lumio?schema=public";
process.env.API_PUBLIC_URL ??= "http://localhost:4100";
process.env.STORAGE_ROOT ??= "apps/api/storage";

const prisma = new PrismaClient();

export async function processNextRenderJob() {
  const job = await prisma.renderJob.findFirst({
    where: { status: "queued", type: { in: ["preview", "final"] } },
    orderBy: { createdAt: "asc" }
  });

  if (!job) {
    return false;
  }

  const claimed = await prisma.renderJob.updateMany({
    where: { id: job.id, status: "queued" },
    data: { status: "processing", progress: 5 }
  });
  if (!claimed.count) {
    return false;
  }

  // Real Remotion cancellation: a poll watches the job row and aborts the render via
  // cancelSignal the moment the status leaves "processing" (a user cancel). This is the
  // supported way to stop a render — throwing inside onProgress doesn't stop Remotion and
  // floods the process with unhandled rejections.
  const { cancelSignal, cancel } = makeCancelSignal();
  let cancelled = false;
  const cancelPoll = setInterval(() => {
    void prisma.renderJob
      .findUnique({ where: { id: job.id }, select: { status: true } })
      .then((fresh) => {
        if (fresh && fresh.status !== "processing" && !cancelled) {
          cancelled = true;
          cancel();
        }
      })
      .catch(() => undefined);
  }, 1000);

  try {
    await prisma.renderJob.update({ where: { id: job.id }, data: { progress: 20 } });

    const project = await prisma.project.findFirst({
      where: { id: job.projectId, userId: job.userId },
      include: { template: true }
    });
    if (!project) {
      throw new Error("Project not found for render job");
    }

    const graph = project.projectGraph as unknown as ProjectGraph;
    const assets = (await prisma.sourceAsset.findMany({ where: { userId: job.userId } })).map(toSourceAsset);
    const manifest =
      job.manifest && typeof job.manifest === "object"
        ? (job.manifest as unknown as RenderManifest)
        : buildRenderManifest({
            projectId: project.id,
            graph,
            assets,
            quality: job.type === "preview" ? "preview" : "final"
          });

    await prisma.renderJob.update({ where: { id: job.id }, data: { progress: 15 } });

    const renderPayload = {
      jobId: job.id,
      project: {
        id: project.id,
        title: project.title,
        template: project.template?.slug ?? "custom"
      },
      manifest
    };
    // The manifest/setup steps above are near-instant (DB lookups), so they
    // only get a small fixed slice (0-15%). The actual frame-by-frame render
    // is genuinely the slow part and is where Remotion's real per-frame
    // progress lives - give it almost the entire bar (15-99%) instead of
    // squeezing it into a narrow band, so the number moves the way the work
    // actually progresses instead of jumping to a fixed checkpoint and crawling.
    const outputUrl = await saveRenderArtifact(
      project.id,
      job.type,
      renderPayload,
      async (progress) => {
        // updateMany only writes while the job is still "processing", so a cancel sticks and
        // we never revive a cancelled job. No throwing here — the cancelSignal stops the render.
        await prisma.renderJob.updateMany({
          where: { id: job.id, status: "processing" },
          data: { progress: Math.max(15, Math.min(99, Math.round(15 + progress * 84))) }
        });
      },
      cancelSignal
    );

    if (job.type === "final") {
      await prisma.$transaction(async (tx) => {
        await tx.renderJob.update({
          where: { id: job.id },
          data: { status: "completed", progress: 100, outputUrl, completedAt: new Date() }
        });
        await tx.project.update({
          where: { id: project.id },
          data: { status: "export_ready", finalUrl: outputUrl }
        });
      });
      return true;
    }

    await prisma.renderJob.update({
      where: { id: job.id },
      data: { status: "completed", progress: 100, outputUrl, completedAt: new Date() }
    });
    await prisma.project.update({
      where: { id: project.id },
      data: { status: "preview_ready", previewUrl: outputUrl }
    });
    return true;
  } catch (error) {
    if (cancelled) {
      // The render was aborted by a user cancel; the job is already "cancelled" in the DB.
      return true;
    }
    // Only mark failed if the job is still processing — a concurrent cancel wins.
    await prisma.renderJob.updateMany({
      where: { id: job.id, status: "processing" },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Render failed",
        progress: 0
      }
    });
    return true;
  } finally {
    clearInterval(cancelPoll);
  }
}

export async function disconnectRenderWorker() {
  await prisma.$disconnect();
}

async function saveRenderArtifact(
  projectId: string,
  type: string,
  payload: { manifest: Parameters<typeof renderManifestToMp4>[0]["manifest"] },
  onProgress: (progress: number) => Promise<void>,
  cancelSignal: Parameters<typeof renderManifestToMp4>[0]["cancelSignal"]
) {
  const root = resolveStorageRoot();
  const folder = type === "preview" ? "previews" : "finals";
  await fs.mkdir(path.join(root, folder), { recursive: true });
  const baseName = `${projectId}-${type}-${Date.now()}`;
  await fs.writeFile(path.join(root, folder, `${baseName}.json`), JSON.stringify(payload, null, 2));
  await renderManifestToMp4({
    manifest: payload.manifest,
    outputLocation: path.join(root, folder, `${baseName}.mp4`),
    onProgress,
    ...(cancelSignal ? { cancelSignal } : {})
  });
  return `${process.env.API_PUBLIC_URL ?? "http://localhost:4100"}/storage/${folder}/${baseName}.mp4`;
}

function resolveStorageRoot() {
  const workspaceRoot = path.resolve(process.cwd(), "../..");
  const storageRoot = process.env.STORAGE_ROOT ?? "apps/api/storage";
  return path.isAbsolute(storageRoot) ? storageRoot : path.resolve(workspaceRoot, storageRoot);
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
  cloudUrl?: string | null;
  proxyUrl?: string | null;
  previewUrl?: string | null;
}): SourceAsset {
  const status: SourceAsset["status"] =
    asset.status === "processing" || asset.status === "ready" || asset.status === "failed" || asset.status === "uploaded"
      ? asset.status
      : "uploaded";
  // The render worker can only fetch HTTP(S); prefer the cloud copy when present so a
  // server-rendered job never points at a browser-local URL.
  const fileUrl = asset.cloudUrl ?? asset.fileUrl;
  return {
    id: asset.id,
    userId: asset.userId,
    fileName: asset.fileName,
    fileType: asset.fileType,
    fileUrl,
    durationSeconds: asset.durationSeconds,
    width: asset.width,
    height: asset.height,
    status,
    createdAt: asset.createdAt.toISOString(),
    ...(asset.cloudUrl ? { cloudUrl: asset.cloudUrl } : {}),
    ...(asset.proxyUrl ? { proxyUrl: asset.proxyUrl } : {}),
    ...(asset.previewUrl ? { previewUrl: asset.previewUrl } : {})
  };
}
