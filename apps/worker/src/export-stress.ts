/**
 * Local-export WebGL context budget gate (`export:stress`).
 *
 * Drives the in-browser stress page (`/editor/__export-stress`) which constructs ONE `SceneFrameCompositor`
 * over a 24-clip timeline (each clip: bloom + blur + grade) and sweeps `renderFrame` across the whole
 * duration. Asserts the WebGL context budget holds:
 *   (a) NO "lost WebGL context" console error during the sweep,
 *   (b) PEAK live context count ≤ SAFE_CONTEXT_THRESHOLD (the media-renderer pool bounds it — without the
 *       pool a 24-clip export hoards ~24 contexts and evicts the preview's),
 *   (c) the count returns to BASELINE after dispose (rule 5: release immediately after export).
 *
 * Standalone assert-and-exit script (repo convention). Needs a real WebGL2 GPU + the export decode path, so
 * run with `PIXEL_BROWSER_CHANNEL=chrome` (bundled Chromium lacks WebGL2 and would render nothing).
 *
 * Reuses the same vite-spawn + free-port + Playwright harness shape as `export-scene-compare.ts`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Past this many LIVE WebGL contexts we risk the browser's ~16 cap (which evicts the preview's context).
// Matches SAFE_CONTEXT_THRESHOLD in apps/web/src/export/scene-frame-compositor.ts.
const SAFE_CONTEXT_THRESHOLD = Number(process.env.EXPORT_GL_THRESHOLD ?? 8);
const CLIP_COUNT = Number(process.env.EXPORT_STRESS_CLIPS ?? 24);

async function main() {
  // Phase 2 Stage 2: EXPORT_SINGLE_CONTEXT=1 measures the single-context export's context peak (expected ~1,
  // vs the multi-context pool's peak) over the same sweep.
  const singleCtxOverride = process.env.EXPORT_SINGLE_CONTEXT;
  const singleCtx = singleCtxOverride != null ? `&exportSingleContext=${encodeURIComponent(singleCtxOverride)}` : "";
  const singleCtxLabel = singleCtxOverride == null ? "single-context default" : `exportSingleContext=${singleCtxOverride}`;
  console.log(`Export WebGL budget stress: ${CLIP_COUNT} clips (bloom + blur + grade), threshold ${SAFE_CONTEXT_THRESHOLD} contexts [${singleCtxLabel}]`);
  const port = await getFreePort();
  const vite = startWebServer(port);
  try {
    const url = `http://127.0.0.1:${port}/editor/__export-stress?clips=${CLIP_COUNT}${singleCtx}`;
    await waitForServer(`http://127.0.0.1:${port}/editor/__export-stress`);
    const result = await runStress(url);

    console.log(`peak=${result.peak} baseline=${result.baseline} final=${result.final}`);
    if (result.lostContextErrors.length) {
      for (const line of result.lostContextErrors) console.log(`  lost-context: ${line}`);
    }

    assert.equal(
      result.lostContextErrors.length,
      0,
      `Export stress hit ${result.lostContextErrors.length} "lost WebGL context" error(s) — the budget did not hold.`
    );
    assert.ok(
      result.peak <= SAFE_CONTEXT_THRESHOLD,
      `Peak WebGL context count ${result.peak} exceeded the safe threshold ${SAFE_CONTEXT_THRESHOLD} — the media-renderer pool is not bounding contexts.`
    );
    assert.ok(
      result.final <= result.baseline,
      `WebGL contexts not released after dispose: final ${result.final} > baseline ${result.baseline} (rule 5).`
    );
    console.log(`Export WebGL budget stress PASSED (peak ${result.peak} ≤ ${SAFE_CONTEXT_THRESHOLD}, released to baseline ${result.baseline}).`);
  } finally {
    await stopProcess(vite);
  }
}

interface StressResult {
  peak: number;
  baseline: number;
  final: number;
  lostContextErrors: string[];
}

async function runStress(url: string): Promise<StressResult> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
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
    // The page sweeps the whole timeline then sets data-render-fixture='ready'; on failure it becomes 'error'.
    const root = page.locator(".export-stress-page");
    await root.waitFor({ state: "attached", timeout: 60_000 });
    await page.locator(".export-stress-page[data-render-fixture='ready'], .export-stress-page[data-render-fixture='error']").waitFor({
      state: "attached",
      timeout: 90_000,
    });

    const status = await root.getAttribute("data-render-fixture");
    if (status === "error") {
      const detail = await page.locator("[data-export-error]").textContent().catch(() => null);
      throw new Error(`Stress page errored: ${detail ?? "unknown"}`);
    }
    const num = async (attr: string) => Number((await root.getAttribute(attr)) ?? "NaN");
    return {
      peak: await num("data-peak-contexts"),
      baseline: await num("data-baseline-contexts"),
      final: await num("data-final-contexts"),
      lostContextErrors,
    };
  } finally {
    await browser.close();
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
