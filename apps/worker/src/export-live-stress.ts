/**
 * Real-world export + live-preview WebGL budget gate (`export:live-stress`).
 *
 * Drives `/editor/__export-live-stress`, which mounts the REAL editor preview (`ScenePreviewCanvas` + live
 * `MediaWebGLRenderer` contexts) AND runs the REAL `exportLocally` pipeline over a 20–30 clip bloom/blur/grade
 * timeline, repeated 2–3×. Asserts the budget holds UNDER actual contention:
 *   (a) default Worker scene export does NOT require preview suspend,
 *   (b) forced main-thread scene fallback (`exportWorkerScene=0`) still observes preview suspend,
 *   (c) the preview never FAILED / fell back to DOM across all exports,
 *   (d) NO "lost WebGL context" console error,
 *   (e) all exports completed,
 *   (f) peak live context count ≤ a generous ceiling (preview + bounded export pool).
 *
 * Standalone assert-and-exit script. Needs a real WebGL2 GPU + WebCodecs encode → `PIXEL_BROWSER_CHANNEL=chrome`.
 * `?exportGlDebug=1` is appended so the `[export-gl]` pool/suspend lines are forwarded for visibility.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const EXPORTS = Number(process.env.EXPORT_LIVE_RUNS ?? 3);
const CLIPS = Number(process.env.EXPORT_LIVE_CLIPS ?? 24);
// Generous: with the preview mounted (~1 scene + 3 media contexts) plus the bounded export pool (~scene + ≤4),
// the real total sits ~9; the ceiling guards against an unbounded regression without being brittle.
const CONTEXT_CEILING = Number(process.env.EXPORT_LIVE_CEILING ?? 14);

async function main() {
  console.log(`Real-world export+preview budget: ${CLIPS} clips, ${EXPORTS} repeated exports, context ceiling ${CONTEXT_CEILING}`);
  const port = await getFreePort();
  const vite = startWebServer(port);
  try {
    const base = `http://127.0.0.1:${port}/editor/__export-live-stress`;
    await waitForServer(base);
    const scenarios = [
      {
        name: "default-worker-scene",
        url: `${base}?clips=${CLIPS}&exports=${EXPORTS}&exportGlDebug=1`,
        expectSuspended: false,
      },
      {
        name: "forced-main-thread-scene",
        url: `${base}?clips=${CLIPS}&exports=${EXPORTS}&exportGlDebug=1&exportWorkerScene=0`,
        expectSuspended: true,
      },
    ] as const;

    for (const scenario of scenarios) {
      const result = await runLiveStress(scenario.url);

      console.log(
        `[${scenario.name}] exportsCompleted=${result.exportsCompleted}/${EXPORTS} sawSuspended=${result.sawSuspended} ` +
          `previewFailed=${result.previewFailed} peak=${result.peak} baseline=${result.baseline} final=${result.final}`
      );
      for (const line of result.lostContextErrors) console.log(`  lost-context: ${line}`);

      assert.equal(result.lostContextErrors.length, 0, `[${scenario.name}] Hit ${result.lostContextErrors.length} lost WebGL context error(s).`);
      assert.equal(result.exportsCompleted, EXPORTS, `[${scenario.name}] Only ${result.exportsCompleted}/${EXPORTS} exports completed.`);
      assert.equal(
        result.sawSuspended,
        scenario.expectSuspended,
        scenario.expectSuspended
          ? `[${scenario.name}] Preview suspend was not observed when Worker scene was forced off.`
          : `[${scenario.name}] Preview suspend was observed during default Worker scene export; expected Worker route without main-thread suspend.`
      );
      assert.ok(!result.previewFailed, `[${scenario.name}] The preview fell back or failed during/after export.`);
      assert.ok(result.peak <= CONTEXT_CEILING, `[${scenario.name}] Peak live WebGL contexts ${result.peak} exceeded ceiling ${CONTEXT_CEILING}.`);
    }
    console.log(`Real-world export+preview budget PASSED (default Worker scene avoided preview suspend; forced main-thread fallback suspended; preview survived both, peak <= ${CONTEXT_CEILING}).`);
  } finally {
    await stopProcess(vite);
  }
}

interface LiveResult {
  exportsCompleted: number;
  sawSuspended: boolean;
  previewFailed: boolean;
  peak: number;
  baseline: number;
  final: number;
  lostContextErrors: string[];
}

async function runLiveStress(url: string): Promise<LiveResult> {
  const browser = await launchBrowser();
  const lostContextErrors: string[] = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 600, height: 900 } });
    const capture = (text: string) => {
      if (/lost webgl context/i.test(text)) lostContextErrors.push(text);
    };
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error" || type === "warning") process.stdout.write(`[page:${type}] ${text}\n`);
      else if (text.startsWith("[export-gl]")) process.stdout.write(`${text}\n`);
      capture(text);
    });
    page.on("pageerror", (err) => {
      process.stdout.write(`[page:exception] ${err.message}\n`);
      capture(err.message);
    });
    await page.goto(url, { waitUntil: "networkidle" });
    const root = page.locator(".export-live-stress-page");
    await root.waitFor({ state: "attached", timeout: 60_000 });
    // Repeated real exports take a while — wait up to 5 min for ready/error.
    await page
      .locator(".export-live-stress-page[data-render-fixture='ready'], .export-live-stress-page[data-render-fixture='error']")
      .waitFor({ state: "attached", timeout: 300_000 });

    const status = await root.getAttribute("data-render-fixture");
    if (status === "error") {
      const detail = await page.locator("[data-export-error]").textContent().catch(() => null);
      throw new Error(`Live-stress page errored: ${detail ?? "unknown"}`);
    }
    const num = async (attr: string) => Number((await root.getAttribute(attr)) ?? "NaN");
    const flag = async (attr: string) => (await root.getAttribute(attr)) === "1";
    return {
      exportsCompleted: await num("data-exports-completed"),
      sawSuspended: await flag("data-saw-suspended"),
      previewFailed: await flag("data-preview-failed"),
      peak: await num("data-peak-contexts"),
      baseline: await num("data-baseline-contexts"),
      final: await num("data-final-contexts"),
      lostContextErrors,
    };
  } finally {
    await browser.close();
  }
}

async function launchBrowser() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  try {
    return await chromium.launch(channel ? { channel } : {});
  } catch (error) {
    const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    if (channel === "chrome" && fs.existsSync(chromePath)) return chromium.launch({ executablePath: chromePath });
    throw error;
  }
}

function startWebServer(port: number) {
  const child = spawn(
    "pnpm",
    ["--dir", path.join(repoRoot, "apps/web"), "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, env: { ...process.env, BROWSER: "none" }, stdio: ["ignore", "pipe", "pipe"], shell: true }
  );
  child.stdout.on("data", (data) => process.stdout.write(`[web] ${data}`));
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
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for web server. Last error: ${String(lastError)}`);
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      const timeout = setTimeout(resolve, 5_000);
      killer.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      killer.once("error", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

main()
  .then(() => process.exit(0)) // spawned vite can keep a grandchild handle open → force a clean exit
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
