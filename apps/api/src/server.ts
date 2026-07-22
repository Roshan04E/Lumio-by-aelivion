import { env } from "./config/env";
import { createApp } from "./app";
import { closeRenderQueue } from "./lib/renderQueue";
import { ensureStorage } from "./services/storage.service";

await ensureStorage();

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`Orreris API listening on http://localhost:${env.PORT}`);
});

// Close the render-queue producer (bullmq mode) on shutdown so Redis connections don't leak.
async function shutdown() {
  await closeRenderQueue().catch(() => undefined);
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
