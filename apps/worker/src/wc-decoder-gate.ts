/**
 * Streaming-demux decoder gate (`wc:gate`).
 *
 * Drives `/editor/__wc-decoder-gate`, which synthesizes real H.264 MP4s in-browser (faststart AND
 * moov-at-end layouts) and runs the real `createWebCodecsVideoSource` provider over them. Asserts:
 *  (a) both variants create a provider via the STREAMING index path (no fragmented fallback,
 *      no whole-file RAM buffer),
 *  (b) every frame check is color-exact (frame-accurate demux offsets/timestamps),
 *  (c) forward decode across multiple chunk windows + a backward jump onto an evicted window.
 *
 * Standalone assert-and-exit script. Needs real WebCodecs encode+decode → `PIXEL_BROWSER_CHANNEL=chrome`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDir = path.join(repoRoot, "apps/web/public/__wc-fixtures");

/**
 * Realistic fixture: H.264 HIGH profile with B-frames, sparse GOP (g=120), AAC audio interleaved,
 * moov at END (no faststart) — the properties real stock footage has and browser-synthesized MP4s
 * don't. testsrc2 makes every frame visually distinct so a frozen decode is detectable.
 */
async function generateRealFixture(): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary unavailable");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const out = path.join(fixtureDir, "real.mp4");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, [
      "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "12",
      "-c:v", "libx264", "-profile:v", "high", "-bf", "2", "-g", "120", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      out,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += String(d)));
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`))));
    proc.on("error", reject);
  });
  console.log(`fixture: ${out} (${fs.statSync(out).size} bytes, high profile + B-frames + audio, moov-at-end)`);
}

interface FrameCheck {
  timeSeconds: number;
  expectedIndex: number;
  measuredR: number;
  measuredB: number;
  ok: boolean;
}

interface VariantResult {
  name: string;
  providerCreated: boolean;
  streamingPathUsed: boolean;
  checks: FrameCheck[];
  ok: boolean;
  error?: string;
}

async function main() {
  // Leftover Playwright trees corrupt this gate — see browser-preflight.ts. MUST run here, at
  // process start, before this gate has launched anything of its own: at a launch site it
  // cannot tell a leftover from a browser this run is already using.
  assertQuietBrowserMachine({ label: "wc:gate" });

  await generateRealFixture();
  const port = await getFreePort();
  const vite = startWebServer(port);
  try {
    // wcDecode=1 enables the pool so the session-prioritization scenario runs too.
    const url = `http://127.0.0.1:${port}/editor/__wc-decoder-gate?exportDecodeDebug=1&wcDecode=1`;
    await waitForServer(url);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      page.on("console", (msg) => {
        const text = msg.text();
        if (msg.type() === "error" || msg.type() === "warning" || text.startsWith("[export]") || text.startsWith("[gate]")) {
          process.stdout.write(`[page:${msg.type()}] ${text}\n`);
        }
      });
      page.on("pageerror", (err) => process.stdout.write(`[page:exception] ${err.message}\n`));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const root = page.locator(".wc-decoder-gate-page");
      await root.waitFor({ state: "attached", timeout: 60_000 });
      await page
        .locator(".wc-decoder-gate-page[data-render-fixture='ready'], .wc-decoder-gate-page[data-render-fixture='error']")
        .waitFor({ state: "attached", timeout: 120_000 });

      const resultsText = (await page.locator("[data-gate-results]").textContent()) ?? "[]";
      const poolText = (await page.locator("[data-gate-pool]").textContent()) ?? "[]";
      const fatal = await page.locator("[data-gate-error]").textContent().catch(() => null);
      const results = JSON.parse(resultsText) as VariantResult[];
      const poolChecks = JSON.parse(poolText) as { name: string; ok: boolean; detail?: string }[];

      for (const variant of results) {
        console.log(
          `[${variant.name}] provider=${variant.providerCreated} streaming=${variant.streamingPathUsed} ` +
            `checks=${variant.checks.filter((c) => c.ok).length}/${variant.checks.length}${variant.error ? ` error=${variant.error}` : ""}`
        );
        for (const check of variant.checks) {
          const expected = Math.round((check.expectedIndex / 239) * 255);
          console.log(
            `   t=${check.timeSeconds.toFixed(2)}s → frame ${check.expectedIndex}: r=${check.measuredR} (want ~${expected}) b=${check.measuredB} ${check.ok ? "✅" : "❌"}`
          );
        }
      }
      for (const check of poolChecks) {
        console.log(`[pool] ${check.name} ${check.ok ? "✅" : "❌"}${check.detail ? ` (${check.detail})` : ""}`);
      }
      assert.ok(!fatal, `Gate page fatal error: ${fatal}`);
      assert.equal(results.length, 2, "Expected faststart + moov-at-end variants.");
      assert.ok(poolChecks.length >= 6, `Pool priority scenario did not run (${poolChecks.length} checks).`);
      assert.ok(
        poolChecks.every((c) => c.ok),
        `Pool priority checks failed: ${poolChecks.filter((c) => !c.ok).map((c) => c.name).join("; ")}`
      );
      for (const variant of results) {
        assert.ok(variant.providerCreated, `[${variant.name}] provider was not created (fell back / demux failed).`);
        assert.ok(variant.streamingPathUsed, `[${variant.name}] streaming index path was NOT used (fragmented fallback or no provider).`);
        assert.ok(
          variant.checks.length > 0 && variant.checks.every((c) => c.ok),
          `[${variant.name}] frame-accuracy checks failed.`
        );
      }
      console.log("WebCodecs streaming-demux gate PASSED (both layouts, frame-accurate, windowed reads, backward jump).");
    } finally {
      await browser.close();
    }
  } finally {
    await stopProcess(vite);
    fs.rmSync(fixtureDir, { force: true, recursive: true });
  }
}

async function launchBrowser() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL ?? "chrome";
  try {
    return await chromium.launch(channel ? { channel } : {});
  } catch (error) {
    const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    if (fs.existsSync(chromePath)) return chromium.launch({ executablePath: chromePath });
    throw error;
  }
}

function startWebServer(port: number) {
  const child = spawn(
    "pnpm",
    ["--dir", path.join(repoRoot, "apps/web"), "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, env: { ...process.env, BROWSER: "none" }, stdio: ["ignore", "pipe", "pipe"], shell: true }
  );
  child.stderr.on("data", (data) => process.stderr.write(`[web] ${data}`));
  return child;
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) resolve(address.port);
        else reject(new Error("Could not find a free port."));
      });
    });
  });
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dev server did not come up: ${String(lastError)}`);
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode != null) return;
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode == null) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
    } catch {
      /* best effort */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
