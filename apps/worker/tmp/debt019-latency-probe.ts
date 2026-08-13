/**
 * DEBT-019 remote half — the risk the split was made for, and RESIDENCY LADDERS CANNOT SEE IT.
 *
 * Range-paging trades one large body for many small requests. That is a straight win on a LAN (the
 * residency ladder's own media server, loopback) and can be a straight loss on a slow link, where
 * per-request latency dominates and a server that answers instantly to one big GET can beat several
 * small ones with round-trip overhead each. This measures the two things a byte-residency number
 * cannot: COLD-START time to first frame, and SEEK latency to a region outside whatever was already
 * fetched — against TWO servers (Range-honoring vs Range-blind, so the RANGED and WHOLE-FILE code
 * paths are both exercised for real, not toggled by a debug flag) and TWO network conditions.
 *
 * Preconditions reported, not assumed (measurement-preconditions rule): PIXEL_BROWSER_CHANNEL=chrome,
 * zero-browser floor before every run, build identity proven serving this worktree, and the subsystem
 * proven live (streaming index, real getFrame results) rather than inferred from a timing number.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome DEBT019_MEDIA_LONG=<120s-corpus-dir> \
 *     pnpm --dir apps/worker exec tsx tmp/debt019-latency-probe.ts
 */
import { createServer, type Server } from "node:http";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertServingThisWorktree, getFreePort, startVite, stopProcess, waitForServer } from "./pull-bootstrap.js";
import { assertZeroBrowserFloor, reapAutomationBrowsers } from "../src/browser/browser-preflight.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LONG_DIR = process.env.DEBT019_MEDIA_LONG ?? "";
/** Where in the clip counts as a "cold" seek target — far from byte 0, forcing a fresh window fetch. */
const COLD_FRACTION = Number(process.env.DEBT019_COLD_FRACTION ?? 0.9);
const CLIP_NAME = process.env.DEBT019_CLIP ?? "src000.mp4";

const LAUNCH_ARGS = [
  "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
];

/** CDP network profiles. FAST = unthrottled loopback (the LAN case). THROTTLED = a poor but not
 * unreasonable real-world link — 5 Mbps down / 1 Mbps up / 120 ms RTT, in the "3G/weak Wi-Fi"
 * band the task calls out as where a browser NLE's users actually are. */
const PROFILES: Record<string, { downloadThroughput: number; uploadThroughput: number; latency: number } | null> = {
  fast: null,
  throttled: { downloadThroughput: (5_000_000 / 8), uploadThroughput: (1_000_000 / 8), latency: 120 },
};

function rangeCapableServer(port: number, root: string): Promise<Server> {
  const base = path.resolve(root);
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\//, "");
    const file = path.resolve(base, name);
    if (!file.startsWith(base)) return void res.writeHead(403).end();
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return void res.writeHead(404).end();
    }
    const head: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
    const m = req.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      // Clamp to size-1 (RFC 7233 §2.1) -- see the matching fix + full explanation in
      // debt019-residency-probe.ts's startMediaServer, found by this same probe family.
      const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
      res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, "Content-Length": String(size) });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** A real category of origin, not a synthetic bypass: answers preflight normally, then ignores
 * `Range` on the actual GET and always returns the whole body with 200 -- exactly what
 * `probeAndBuildRangedSource` is built to detect and degrade honestly from. This is how the
 * WHOLE-FILE code path (`fetchSourceBlob`) gets exercised for real in this probe, not toggled by a
 * debug flag the shipped code doesn't have. */
function rangeBlindServer(port: number, root: string): Promise<Server> {
  const base = path.resolve(root);
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\//, "");
    const file = path.resolve(base, name);
    if (!file.startsWith(base)) return void res.writeHead(403).end();
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return void res.writeHead(404).end();
    }
    // NO Accept-Ranges, NO 206 -- ignores any Range header entirely, always the whole file.
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(size) });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

interface Row {
  server: string;
  network: string;
  coldStartMs: number;
  seekMs: number;
  gotFrame0: boolean;
  gotFrameCold: boolean;
  streaming: number;
  fragmented: number;
  copiedBytes: number;
  rangedBytes: number;
  fileBytes: number;
  providerKind: string;
}

async function main() {
  if (!LONG_DIR) throw new Error("set DEBT019_MEDIA_LONG to a corpus dir with src*.mp4 files");
  const clipPath = path.join(LONG_DIR, CLIP_NAME);
  const fileBytes = statSync(clipPath).size;
  const clipEndGuess = 118; // corpus clips are ~120s; conservative so the cold-fraction stays in-range

  console.log("PRECONDITIONS");
  console.log(`  PIXEL_BROWSER_CHANNEL : ${process.env.PIXEL_BROWSER_CHANNEL ?? "(unset -> chrome default)"}`);
  console.log(`  clip                  : ${clipPath} (${(fileBytes / 1048576).toFixed(1)} MB)`);
  console.log(`  cold seek target      : ${(clipEndGuess * COLD_FRACTION).toFixed(1)}s of ~${clipEndGuess}s`);

  const vitePort = await getFreePort();
  const vite = startVite(vitePort);
  const origin = `http://127.0.0.1:${vitePort}`;
  const rows: Row[] = [];

  try {
    await waitForServer(origin);
    console.log(`  build identity        : ${await assertServingThisWorktree(origin)}\n`);

    const rangePort = await getFreePort();
    const blindPort = await getFreePort();
    const rangeServer = await rangeCapableServer(rangePort, LONG_DIR);
    const blindServer = await rangeBlindServer(blindPort, LONG_DIR);
    const servers: Array<{ label: string; port: number }> = [
      { label: "ranged", port: rangePort },
      { label: "wholefile(degraded)", port: blindPort },
    ];

    try {
      for (const { label, port } of servers) {
        for (const [netLabel, netProfile] of Object.entries(PROFILES)) {
          assertZeroBrowserFloor(`debt019-latency ${label}/${netLabel}`);
          const browser = await chromium.launch({
            channel: process.env.PIXEL_BROWSER_CHANNEL ?? "chrome",
            args: LAUNCH_ARGS,
          });
          const page = await browser.newPage();
          await page.route(`${origin}/__pull_probe`, (r) =>
            r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>debt019-latency</title><body>" })
          );
          await page.goto(`${origin}/__pull_probe`);
          // Warm the app's OWN module graph (source-decoder/webcodecs-decoder + transitive deps)
          // BEFORE throttling -- a fresh browser has nothing cached, and fetching Vite's dev module
          // graph (many small ESM files) over a throttled connection is a real but SEPARATE cost from
          // fetching source bytes, the thing this probe measures. Without this the throttled runs
          // sometimes failed outright ("Failed to fetch dynamically imported module") rather than
          // measuring anything -- an app-load timeout, not a range-paging result.
          await page.evaluate(async () => {
            await import(/* @vite-ignore */ "/src/export/source-decoder.ts");
            await import(/* @vite-ignore */ "/src/export/webcodecs-decoder.ts");
          });

          if (netProfile) {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send("Network.enable");
            await cdp.send("Network.emulateNetworkConditions", { offline: false, ...netProfile });
          }

          const url = `http://127.0.0.1:${port}/${CLIP_NAME}`;
          const coldSeconds = clipEndGuess * COLD_FRACTION;
          const result = (await page.evaluate(
            async ({ url, coldSeconds }: { url: string; coldSeconds: number }) => {
              const sd = await import(/* @vite-ignore */ "/src/export/source-decoder.ts");
              const wc = await import(/* @vite-ignore */ "/src/export/webcodecs-decoder.ts");
              const t0 = performance.now();
              const p = await sd.createFrameProvider(url, "video");
              if (!p) return { error: "createFrameProvider returned null (fell back to <video> or failed entirely)" };
              const f0 = await p.getFrame(0);
              const coldStartMs = performance.now() - t0;

              const t1 = performance.now();
              const end = p.decodableEndSeconds ?? coldSeconds;
              const target = Math.min(coldSeconds, Math.max(0, end - 0.2));
              const fCold = await p.getFrame(target);
              const seekMs = performance.now() - t1;

              const res = wc.sourceResidentBytes();
              return {
                coldStartMs,
                seekMs,
                gotFrame0: Boolean(f0),
                gotFrameCold: Boolean(fCold),
                streaming: wc.wcDecoderStats.streaming,
                fragmented: wc.wcDecoderStats.fragmented,
                copiedBytes: res.copiedBytes,
                rangedBytes: res.rangedBytes,
                // __wcDecodeCalls only exists on a WebCodecs provider (see webcodecs-decoder.ts's
                // Object.defineProperty at the end of createWebCodecsVideoSource) -- distinguishes
                // "webcodecs succeeded" from "fell through to the <video> element fallback" when
                // streaming/fragmented both read 0, which is otherwise ambiguous.
                providerKind: "__wcDecodeCalls" in p ? "webcodecs" : "video-fallback",
              };
            },
            { url, coldSeconds }
          )) as
            | { error: string }
            | {
                coldStartMs: number;
                seekMs: number;
                gotFrame0: boolean;
                gotFrameCold: boolean;
                streaming: number;
                fragmented: number;
                copiedBytes: number;
                rangedBytes: number;
                providerKind: string;
              };

          if ("error" in result) {
            console.log(`  ${label.padEnd(20)} ${netLabel.padEnd(10)}  FAILED: ${result.error}`);
          } else {
            rows.push({ server: label, network: netLabel, fileBytes, ...result });
            console.log(
              `  ${label.padEnd(20)} ${netLabel.padEnd(10)}  cold ${result.coldStartMs.toFixed(0).padStart(7)}ms  ` +
                `seek ${result.seekMs.toFixed(0).padStart(7)}ms  frame0=${result.gotFrame0} frameCold=${result.gotFrameCold} ` +
                `provider=${result.providerKind} streaming=${result.streaming} frag=${result.fragmented} copied=${(result.copiedBytes / 1048576).toFixed(1)}MB ranged=${(result.rangedBytes / 1048576).toFixed(1)}MB`
            );
          }
          await browser.close();
        }
      }
    } finally {
      rangeServer.close();
      blindServer.close();
    }

    console.log(`\n${"=".repeat(100)}`);
    console.log("DEBT-019 remote latency — cold-start and cold-seek, ranged vs whole-file(degraded), fast vs throttled");
    console.log(`${"=".repeat(100)}`);
    for (const netLabel of Object.keys(PROFILES)) {
      const ranged = rows.find((r) => r.server === "ranged" && r.network === netLabel);
      const whole = rows.find((r) => r.server === "wholefile(degraded)" && r.network === netLabel);
      if (ranged && whole) {
        const coldDeltaMs = ranged.coldStartMs - whole.coldStartMs;
        const verdict = coldDeltaMs > 0 ? `ranged cold-start is ${coldDeltaMs.toFixed(0)}ms SLOWER` : `ranged cold-start is ${(-coldDeltaMs).toFixed(0)}ms FASTER`;
        console.log(`${netLabel.padEnd(10)}  ${verdict}  (ranged ${ranged.coldStartMs.toFixed(0)}ms vs whole-file ${whole.coldStartMs.toFixed(0)}ms)`);
        console.log(`${" ".repeat(10)}  seek: ranged ${ranged.seekMs.toFixed(0)}ms vs whole-file ${whole.seekMs.toFixed(0)}ms`);
      }
    }
    console.log(`\n  chrome.exe after run  : (reaped below)`);
  } finally {
    await stopProcess(vite);
    reapAutomationBrowsers();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
