import { Worker } from "bullmq";
import type { WorkerJobPayload } from "./jobs";
import { disconnectRenderWorker, processNextRenderJob } from "./render-worker";

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
  const worker = new Worker<WorkerJobPayload>(
    "kimera-jobs",
    async (job) => {
      console.log(`[bullmq-worker] processing ${job.data.type}`, job.data);
      return {
        ok: true,
        note: "Real FFmpeg/Remotion/MediaPipe processing plugs in here."
      };
    },
    { connection }
  );

  return {
    async start() {
      console.log("Worker running with BullMQ queue: kimera-jobs");
    },
    async stop() {
      await worker.close();
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
