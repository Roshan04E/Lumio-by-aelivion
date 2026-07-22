import express from "express";
import cors from "cors";
import { env } from "./config/env";
import { getObjectStream, isR2Storage, storagePaths } from "./services/storage.service";
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

  // PUBLIC media (/storage) — mounted BEFORE the strict /api CORS gate below, with permissive
  // CORS. These are non-credentialed capability-URL reads (unguessable per-user keys) consumed
  // cross-origin by the editor AND by the export worker's headless browser, whose Remotion bundle
  // is served from its own origin (e.g. http://localhost:3000). The strict gate THROWS for unknown
  // origins (→ 500 with no ACAO header), which silently broke every render-time media fetch.
  app.use("/storage", (_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  });
  if (isR2Storage) {
    // r2 driver without a public base URL: proxy reads from the bucket (keeps a private bucket working
    // and preserves the /storage/<key> URL shape). Set R2_PUBLIC_BASE_URL to serve directly instead.
    // On a bucket miss it FALLS THROUGH (next()) to the on-disk static handler below: media uploaded
    // before the R2 flip exists only on local disk, and 404ing it black-holed those older projects.
    app.use("/storage", (req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.status(405).end();
        return;
      }
      const key = decodeURIComponent(req.path.replace(/^\/+/, ""));
      if (!key || key.includes("..")) {
        res.status(400).end();
        return;
      }
      // Forward the client's Range so R2 serves partial content. Without this, video seeking (the
      // export worker's Remotion OffthreadVideo, editor scrubbing) re-downloads the whole file per
      // frame and renders time out. Advertise Accept-Ranges so clients know seeking is supported.
      const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
      void getObjectStream(key, range)
        .then(({ body, contentType, contentLength, contentRange }) => {
          if (contentType) res.setHeader("Content-Type", contentType);
          res.setHeader("Accept-Ranges", "bytes");
          if (contentRange) {
            res.setHeader("Content-Range", contentRange);
            res.status(206); // Partial Content — R2 honored the Range
          }
          if (contentLength !== undefined) res.setHeader("Content-Length", String(contentLength));
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          body.on("error", () => void (res.destroyed || res.status(502).end()));
          body.pipe(res);
        })
        .catch(() => next());
    });
  }
  // Local disk: the primary store for the local driver, and the read-through fallback for
  // pre-R2 media when the r2 driver is active. express.static 404s anything truly missing.
  app.use("/storage", express.static(storagePaths.root));

  // Strict origin gate for the credentialed /api surface (and everything below).
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

  app.get("/health", (_req, res) => {
    res.json({ success: true, message: "Orreris API is healthy", data: { uptime: process.uptime() } });
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
