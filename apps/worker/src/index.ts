import path from "node:path";
import dotenv from "dotenv";
import { createBullMqRunner, createMockRunner } from "./queue";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config();

// Keep the worker alive when a background task throws outside an awaited chain — most often
// Remotion's Chrome Headless Shell download failing with ECONNRESET (a socket-close 'error'
// surfaced as an unhandled rejection). Without this the whole process exits and takes the rest
// of `pnpm dev` down with it; the failing render job is already marked "failed" by its own
// try/catch. Set REMOTION_BROWSER_EXECUTABLE to an installed Chrome/Edge to skip the download.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] Unhandled rejection (continuing):", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[worker] Uncaught exception (continuing):", error);
});

const queueMode = process.env.WORKER_QUEUE ?? "mock";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const runner = queueMode === "bullmq" ? createBullMqRunner(redisUrl) : createMockRunner();

await runner.start();

process.on("SIGINT", async () => {
  await runner.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await runner.stop();
  process.exit(0);
});
