import express from "express";
import cors from "cors";
import { env } from "./config/env";
import { storagePaths } from "./services/storage.service";
import { authRouter } from "./routes/auth.routes";
import { templatesRouter } from "./routes/templates.routes";
import { toolsRouter } from "./routes/tools.routes";
import { assetsRouter } from "./routes/assets.routes";
import { stockRouter } from "./routes/stock.routes";
import { projectsRouter } from "./routes/projects.routes";
import { jobsRouter } from "./routes/jobs.routes";
import { paymentsRouter } from "./routes/payments.routes";
import { pluginPackagesRouter } from "./routes/plugin-packages.routes";
import { aiRouter } from "./routes/ai.routes";
import { generateRouter } from "./routes/generate.routes";
import { memoryRouter } from "./routes/memory.routes";
import { errorHandler, notFound } from "./middleware/error";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === env.WEB_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1):(517\d|4173)$/.test(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`CORS origin not allowed: ${origin}`));
      },
      credentials: true
    })
  );
  app.use(express.json({ limit: "4mb" }));
  app.use("/storage", express.static(storagePaths.root));

  app.get("/health", (_req, res) => {
    res.json({ success: true, message: "Kimera API is healthy", data: { uptime: process.uptime() } });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/templates", templatesRouter);
  app.use("/api/tools", toolsRouter);
  app.use("/api/assets", assetsRouter);
  app.use("/api/stock", stockRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/plugin-packages", pluginPackagesRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/generate", generateRouter);
  app.use("/api/memory", memoryRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
