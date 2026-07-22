import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { buildRenderManifest, type RenderManifest } from "@orreris/render-templates";
import { type ProjectGraph, type SourceAsset } from "@orreris/shared";
import { persistBytes } from "@orreris/storage";
import { localizeManifestMedia } from "./asset-localizer";
import { makeCancelSignal } from "@remotion/renderer";
import { renderManifestToMp4 } from "./remotion-renderer";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(workerRoot, "../..");

dotenv.config({ path: path.join(workspaceRoot, ".env") });
dotenv.config({ path: path.join(workspaceRoot, ".env.local"), override: true });
dotenv.config({ path: path.join(workerRoot, ".env") });
dotenv.config({ path: path.join(workerRoot, ".env.local"), override: true });

process.env.DATABASE_URL ??= "postgresql://orreris:orreris@localhost:5432/orreris?schema=public";
process.env.API_PUBLIC_URL ??= "http://localhost:4100";
process.env.STORAGE_ROOT ??= "apps/api/storage";

// Singleton Prisma client. The worker runs under `tsx watch`, which reloads on every change to its
// own files OR to imported workspace packages (@orreris/shared / render-templates). A bare
// `new PrismaClient()` per reload opened a fresh pool (default 9 connections) and never disconnected
// the old one, so orphaned pools accumulated until Postgres hit max_connections → P2024 "Timed out
// fetching a connection from the pool". Two guards: (1) cache the client on globalThis like the API
// (apps/api/src/lib/prisma.ts) so in-process reloads reuse one pool; (2) cap this poller's pool small —
// it's a single sequential job loop that never needs 9 connections — so even a full-restart leak can't
// exhaust Postgres.
declare global {
  // eslint-disable-next-line no-var
  var __orrerisWorkerPrisma: PrismaClient | undefined;
}

function workerPrismaUrl(): string {
  const base = process.env.DATABASE_URL ?? "postgresql://orreris:orreris@localhost:5432/orreris?schema=public";
  try {
    const url = new URL(base);
    if (!url.searchParams.has("connection_limit")) {
      url.searchParams.set("connection_limit", "3");
    }
    return url.toString();
  } catch {
    return base;
  }
}

const prisma =
  globalThis.__orrerisWorkerPrisma ?? new PrismaClient({ datasources: { db: { url: workerPrismaUrl() } } });

if (process.env.NODE_ENV !== "production") {
  globalThis.__orrerisWorkerPrisma = prisma;
}

/** Poller entry (mock / DB-polling mode): claim + render the OLDEST queued job, if any. */
export async function processNextRenderJob() {
  const job = await prisma.renderJob.findFirst({
    where: { status: "queued", type: { in: ["preview", "final"] } },
    orderBy: { createdAt: "asc" }
  });
  if (!job) {
    return false;
  }
  return runRenderJob(job);
}

/**
 * BullMQ entry (push mode): claim + render a SPECIFIC job by id. Returns false (no-op) if the row is
 * gone or already claimed — the atomic claim in runRenderJob makes a duplicate delivery harmless.
 */
export async function processRenderJobById(renderJobId: string) {
  const job = await prisma.renderJob.findUnique({ where: { id: renderJobId } });
  if (!job || (job.type !== "preview" && job.type !== "final")) {
    return false;
  }
  return runRenderJob(job);
}

async function runRenderJob(job: NonNullable<Awaited<ReturnType<typeof prisma.renderJob.findFirst>>>) {
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
  // Cleanup for localized source media (loopback server + temp downloads); runs in the finally below.
  let localizedCleanup: (() => Promise<void>) | null = null;
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

    // Localize R2-backed source media to local disk and serve it to Remotion from a loopback file
    // server, so the render never streams from R2 during frame extraction. R2 intermittently severs
    // long streaming GETs from some networks (proven: a 10.9MB clip truncated mid-stream ~half the time
    // while small ranged reads were 100% reliable) — one sever aborted the render and orphaned the job.
    // localizeManifestMedia downloads each source ONCE in ranged chunks with per-chunk retry, then
    // rewrites the manifest to 127.0.0.1 URLs. No-op for the local driver. Torn down in the finally.
    const localized = await localizeManifestMedia(manifest);
    localizedCleanup = localized.cleanup;

    const renderPayload = {
      jobId: job.id,
      project: {
        id: project.id,
        title: project.title,
        template: project.template?.slug ?? "custom"
      },
      manifest: localized.manifest
    };
    // The manifest/setup steps above are near-instant (DB lookups), so they only get a small fixed
    // slice (0-15%). The frame-by-frame render is the slow part with real per-frame progress — give
    // it the bulk of the bar (15-95%). The final 95-99% band is the R2 upload of the finished mp4,
    // which persistBytes does in one shot with no sub-progress; reserving a band for it means the
    // bar visibly advances into an "uploading" phase instead of freezing at 99% during the upload
    // (see getRenderNotice on the web, which labels >95% as the upload step).
    const outputUrl = await saveRenderArtifact(
      project.id,
      job.type,
      renderPayload,
      async (progress) => {
        // updateMany only writes while the job is still "processing", so a cancel sticks and
        // we never revive a cancelled job. No throwing here — the cancelSignal stops the render.
        await prisma.renderJob.updateMany({
          where: { id: job.id, status: "processing" },
          data: { progress: Math.max(15, Math.min(95, Math.round(15 + progress * 80))) }
        });
      },
      async () => {
        // Render done, uploading the mp4 to storage — advance into the reserved upload band.
        await prisma.renderJob.updateMany({
          where: { id: job.id, status: "processing" },
          data: { progress: 97 }
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
        // Surface the finished export in the media bin as a reusable clip: a SourceAsset in the
        // Local tab under a "Rendered" folder (folder "local/Rendered", source "local"), owned by
        // this project. Points at the SAME stored mp4 (outputUrl) — no re-upload. Each export adds a
        // new entry; dimensions/duration come from the manifest so the bin card is correct.
        await tx.sourceAsset.create({
          data: {
            userId: job.userId,
            fileName: `${project.title || "Export"}.mp4`,
            originalName: `${project.title || "Export"}.mp4`,
            fileType: "video/mp4",
            fileUrl: outputUrl,
            durationSeconds: manifest.output.durationSeconds,
            width: manifest.output.width,
            height: manifest.output.height,
            status: "ready",
            source: "local",
            folder: "local/Rendered",
            ownerProjectId: project.id
          }
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
    if (localizedCleanup) {
      await localizedCleanup();
    }
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
  onUploadStart: () => Promise<void>,
  cancelSignal: Parameters<typeof renderManifestToMp4>[0]["cancelSignal"]
) {
  // Remotion can only write to a LOCAL file path, so render to a throwaway temp dir, then upload the
  // bytes through the shared storage abstraction (@orreris/storage). Under STORAGE_DRIVER=local this
  // writes to apps/api/storage/<folder>/… with the same public URL as before; under r2 it uploads to
  // the bucket — the render worker and API now share ONE storage implementation (no drift, and the
  // API and worker no longer have to share a filesystem when deployed as separate containers).
  const folder = type === "preview" ? "previews" : "finals";
  const baseName = `${projectId}-${type}-${Date.now()}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orreris-render-"));
  const tmpOut = path.join(tmpDir, `${baseName}.mp4`);
  try {
    await renderManifestToMp4({
      manifest: payload.manifest,
      outputLocation: tmpOut,
      onProgress,
      ...(cancelSignal ? { cancelSignal } : {})
    });
    const bytes = await fs.readFile(tmpOut);
    await onUploadStart();
    return await persistBytes(`${folder}/${baseName}.mp4`, bytes, "video/mp4");
  } finally {
    // Clears the mp4 and any audio-post-mix "<baseName>.mp4.video.mp4" intermediate in one shot.
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
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
