import express from "express";
import type { Response } from "express";
import type { Readable } from "node:stream";
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

// The R2 object stream (`getObjectStream` → `out.Body`) intermittently truncates — it ends BEFORE the
// advertised Content-Length, which the browser reports as ERR_CONTENT_LENGTH_MISMATCH. A single flaky
// read then black-holes both the editor's `<video>` playback (a stalled decoder → frozen preview) and
// the ingest-proxy full-file download (a failed build → the source stuck on its heavy original). This
// resumes the read: it counts bytes delivered and, on a premature end/error, re-issues a ranged GET
// from the next byte into the SAME response, capped so a genuinely-broken object can't loop forever.
const R2_MAX_RESUME = 5;

function parseRangeStart(range: string | undefined): number {
  const m = /bytes=(\d+)-/.exec(range ?? "");
  return m ? Number(m[1]) : 0;
}

async function streamFromR2WithResume(
  key: string,
  range: string | undefined,
  headOnly: boolean,
  res: Response
): Promise<void> {
  const first = await getObjectStream(key, range);
  if (first.contentType) res.setHeader("Content-Type", first.contentType);
  res.setHeader("Accept-Ranges", "bytes");
  if (first.contentRange) {
    res.setHeader("Content-Range", first.contentRange);
    res.status(206); // Partial Content — R2 honored the Range
  }
  if (first.contentLength !== undefined) res.setHeader("Content-Length", String(first.contentLength));
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  if (headOnly) {
    (first.body as Readable).destroy();
    res.end();
    return;
  }

  const startByte = parseRangeStart(range); // absolute offset of this response within the object
  const expected = first.contentLength; // bytes to deliver in THIS response
  const endByte = expected !== undefined ? startByte + expected - 1 : undefined;

  await new Promise<void>((resolve, reject) => {
    let sent = 0;
    let attempt = 0;
    /** `sent` at the last resume — used to tell a progressing reconnect from a stuck one. */
    let lastResumeSent = 0;
    let aborted = false;
    let current: Readable | null = null;

    const onClientGone = () => {
      // Client cancelled (e.g. a <video> seek abandons its Range request) — benign, never a truncation.
      aborted = true;
      current?.destroy();
      resolve();
    };
    res.on("close", onClientGone);
    const finish = (fn: () => void) => {
      res.off("close", onClientGone);
      fn();
    };

    const resume = async () => {
      // The cap must bound FUTILE retries, not total ones. Counting every resume killed transfers that
      // were succeeding: a large object over a flaky link legitimately needs more than R2_MAX_RESUME
      // reconnects, each delivering real bytes, and the 6th was rejected → the socket was destroyed →
      // the browser reported ERR_CONTENT_LENGTH_MISMATCH anyway (the exact failure this exists to stop,
      // user report 2026-07-27). Forward progress resets the budget; only consecutive no-progress
      // attempts count, so a genuinely dead object still can't loop forever.
      if (sent > lastResumeSent) {
        attempt = 0;
        lastResumeSent = sent;
      }
      attempt += 1;
      if (attempt > R2_MAX_RESUME) {
        current?.destroy();
        finish(() => reject(new Error("r2 resume cap exceeded")));
        return;
      }
      try {
        const part = await getObjectStream(key, `bytes=${startByte + sent}-${endByte !== undefined ? endByte : ""}`);
        if (aborted) {
          (part.body as Readable).destroy();
          return;
        }
        attach(part.body as Readable);
      } catch {
        finish(() => reject(new Error("r2 resume fetch failed")));
      }
    };

    const attach = (stream: Readable) => {
      current = stream;
      stream.on("data", (chunk: Buffer) => {
        sent += chunk.length;
      });
      stream.pipe(res, { end: false });
      stream.on("end", () => {
        if (aborted) return;
        if (expected === undefined || sent >= expected) {
          finish(() => {
            res.end();
            resolve();
          });
        } else {
          void resume(); // stream cut short of Content-Length — pick up where it stopped
        }
      });
      stream.on("error", () => {
        if (aborted) return;
        // Everything was already delivered — an error on the tail of a complete body is not a failure.
        if (expected !== undefined && sent >= expected) {
          finish(() => {
            res.end();
            resolve();
          });
          return;
        }
        // Otherwise resume, and let `resume` apply the (progress-aware) cap — this used to carry its own
        // stricter `attempt < R2_MAX_RESUME` test, so the two gates disagreed about when to give up.
        void resume();
      });
    };

    attach(first.body as Readable);
  });
}

export function createApp() {
  const app = express();

  // PUBLIC media (/storage) — mounted BEFORE the strict /api CORS gate below, with permissive
  // CORS. These are non-credentialed capability-URL reads (unguessable per-user keys) consumed
  // cross-origin by the editor AND by the export worker's headless browser, whose Remotion bundle
  // is served from its own origin (e.g. http://localhost:3000). The strict gate THROWS for unknown
  // origins (→ 500 with no ACAO header), which silently broke every render-time media fetch.
  app.use("/storage", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    // Range-paged remote reads (webcodecs-decoder.ts) issue plain fetch() calls with an explicit
    // Range header -- a non-simple header, so the browser preflights with OPTIONS before the first
    // ranged GET to a given URL. Without these three headers the preflight fell through to the
    // R2/static handlers below (405 for OPTIONS, or a static 200 with no CORS headers at all) and the
    // browser blocked every real range fetch. Content-Range/Accept-Ranges are also not on the
    // cross-origin response-header safelist, so without Expose-Headers a 206 response's total size is
    // invisible to fetch() even though the request itself succeeds.
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    // Cache the preflight per URL so a session's many windowed range reads pay it once, not once per
    // window -- this is the difference between one extra round trip per source and one per GOP.
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
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
      // `streamFromR2WithResume` resumes flaky/truncated R2 reads (ERR_CONTENT_LENGTH_MISMATCH) so a
      // single short stream no longer freezes playback or fails an ingest-proxy build.
      const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
      void streamFromR2WithResume(key, range, req.method === "HEAD", res).catch(() => {
        // Nothing delivered yet → fall through to the on-disk static handler (pre-R2 media). Once bytes
        // (and headers) are on the wire, resumes are exhausted — just drop the socket.
        if (!res.headersSent) next();
        else if (!res.destroyed) res.destroy();
      });
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
