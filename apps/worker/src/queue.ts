import { Worker } from "bullmq";
import { RENDER_QUEUE_NAME, type RenderQueueJobData } from "@orreris/shared";
import type { WorkerJobPayload } from "./jobs";
import { disconnectRenderWorker, processNextRenderJob, processRenderJobById } from "./render-worker";

export interface JobRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createMockRunner(jobs: WorkerJobPayload[] = []): JobRunner {
  let timer: NodeJS.Timeout | undefined;
  let busy = false;
  let index = 0;

  return {
    async start() {
      console.log("Worker running in database polling mode. Set WORKER_QUEUE=bullmq to use Redis/BullMQ later.");
      const tick = async () => {
        if (busy) {
          return;
        }
        busy = true;
        const processed = await processNextRenderJob();
        busy = false;
        if (processed) {
          return;
        }

        const job = jobs[index % jobs.length];
        index += 1;
        if (!job) {
          return;
        }
        console.log(`[mock-worker] ${job.type} completed`, {
          jobId: job.id,
          projectId: job.projectId,
          sourceAssetId: job.sourceAssetId
        });
      };
      await tick();
      timer = setInterval(tick, 2000);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
      }
      await disconnectRenderWorker();
    }
  };
}

export function createBullMqRunner(redisUrl: string): JobRunner {
  const connection = parseRedisUrl(redisUrl);
  // Push-based dispatch: the API enqueues { renderJobId } when it creates a RenderJob row; we render
  // that specific job through the SAME real pipeline the DB poller uses. Progress/status/cancel still
  // live on the DB row (the render writes progress; a cancel flips the row and the render aborts), so
  // BullMQ only replaces the "find work" step. concurrency 1 = one render at a time per process; scale
  // by running more worker replicas (the atomic claim keeps each job to exactly one).
  const worker = new Worker<RenderQueueJobData>(
    RENDER_QUEUE_NAME,
    async (job) => {
      await processRenderJobById(job.data.renderJobId);
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, error) => {
    console.error(`[bullmq-worker] job ${job?.id ?? "?"} failed:`, error);
  });

  return {
    async start() {
      console.log(`Worker running with BullMQ queue: ${RENDER_QUEUE_NAME}`);
    },
    async stop() {
      await worker.close();
      await disconnectRenderWorker();
    }
  };
}

function parseRedisUrl(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {})
  };
}
