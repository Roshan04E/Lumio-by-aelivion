import { Queue } from "bullmq";
import { RENDER_QUEUE_NAME, type RenderQueueJobData } from "@orreris/shared";
import { env } from "../config/env";

/**
 * Render-queue PRODUCER (the worker is the consumer — apps/worker/src/queue.ts). Only active when
 * WORKER_QUEUE=bullmq; in the default "mock" mode this is a no-op and the worker polls Postgres.
 *
 * We enqueue only the RenderJob id — the DB row is the source of truth for the manifest, progress,
 * status and cancellation. BullMQ is purely the "job is ready" push channel.
 */

let queue: Queue<RenderQueueJobData> | null = null;

function parseRedisUrl(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {})
  };
}

function getQueue(): Queue<RenderQueueJobData> {
  if (!queue) {
    queue = new Queue<RenderQueueJobData>(RENDER_QUEUE_NAME, { connection: parseRedisUrl(env.REDIS_URL) });
  }
  return queue;
}

/** Push a render job for a worker to consume. No-op in mock (DB-poll) mode. */
export async function enqueueRenderJob(renderJobId: string): Promise<void> {
  if (env.WORKER_QUEUE !== "bullmq") {
    return;
  }
  await getQueue().add("render", { renderJobId }, { removeOnComplete: true, removeOnFail: 100 });
}

/** Close the producer connection on shutdown (best-effort). */
export async function closeRenderQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
