/**
 * GPU preview-contention stress gate (`governor:stress`) — the gate todo.md/GAPS.md require before the
 * context governor's default flips ON.
 *
 * Drives `/editor/__governor-stress` (see `GovernorStressPage.tsx`), which reproduces the historical
 * context-leak shape with REAL `MediaWebGLRenderer`s + the REAL `ScenePreviewCanvas`: playback waves of
 * per-clip contexts that idle without unmounting, then a backward-seek revisit. Two scenarios:
 *
 *   1. `?glGovernor=1` (enforced): peak live contexts ≤ ENFORCED_CEILING, at least one LRU eviction
 *      actually happened, every revisited slot lazily recreated + drew cleanly, the preview never
 *      failed/fell back, and no lost-context error hit the console.
 *   2. `?glGovernor=0` (control): peak EXCEEDS the governor hard cap (4) — proves the fixture creates
 *      genuine contention, so scenario 1 can't rot into a tautology.
 *
 * Standalone assert-and-exit script (repo convention — no test framework). Needs a real WebGL2 GPU →
 * `PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker governor:stress`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Governor budget: target 3 / hard cap 4 (gl-context.ts). The governor NEVER evicts a context drawn
// within EVICT_IDLE_MS (200ms) — a visible layer is worth more than the cap — so with back-to-back
// 3-clip waves the structural steady state is root scene compositor (1) + the newly allocated wave (3)
// + the just-stopped previous wave that isn't idle-evictable yet (3) = 7, BOUNDED. The gate asserts
// that bound holds (vs the control run's unbounded ~13): anything above 7 means enforcement failed.
const GOVERNOR_HARD_CAP = 4;
const ENFORCED_CEILING = Number(process.env.GOVERNOR_STRESS_CEILING ?? 7);

interface StressResult {
  governor: boolean;
  peak: number;
  evictions: number;
  recreateFailures: number;
  previewFailed: boolean;
  final: number;
  lostContextErrors: string[];
}

async function main() {
  console.log(`Governor contention stress: enforced ceiling ${ENFORCED_CEILING}, hard cap ${GOVERNOR_HARD_CAP}`);
  const port = await getFreePort();
  const vite = startWebServer(port);
  try {
    const base = `http://127.0.0.1:${port}/editor/__governor-stress`;
    await waitForServer(base);

    const enforced = await runStress(`${base}?glGovernor=1`);
    console.log(
      `[enforced] peak=${enforced.peak} evictions=${enforced.evictions} recreateFailures=${enforced.recreateFailures} ` +
        `previewFailed=${enforced.previewFailed} final=${enforced.final}`
    );
    for (const line of enforced.lostContextErrors) console.log(`  lost-context: ${line}`);
    assert.ok(enforced.governor, "[enforced] Page did not report the governor as enabled.");
    assert.equal(enforced.lostContextErrors.length, 0, `[enforced] Hit ${enforced.lostContextErrors.length} lost WebGL context error(s).`);
    assert.ok(
      enforced.peak <= ENFORCED_CEILING,
      `[enforced] Peak live contexts ${enforced.peak} exceeded ceiling ${ENFORCED_CEILING} — governor did not bound the budget.`
    );
    assert.ok(enforced.evictions >= 1, "[enforced] No LRU eviction happened — the fixture never exercised enforcement.");
    assert.equal(enforced.recreateFailures, 0, `[enforced] ${enforced.recreateFailures} evicted slot(s) failed to lazily recreate.`);
    assert.ok(!enforced.previewFailed, "[enforced] The root scene preview failed or fell back to DOM under enforcement.");
    assert.ok(
      enforced.final <= ENFORCED_CEILING,
      `[enforced] Final live contexts ${enforced.final} exceeded ceiling ${ENFORCED_CEILING} — the budget did not settle.`
    );

    const control = await runStress(`${base}?glGovernor=0`);
    console.log(`[control] peak=${control.peak} evictions=${control.evictions} previewFailed=${control.previewFailed} final=${control.final}`);
    assert.ok(!control.governor, "[control] Page unexpectedly reported the governor as enabled.");
    assert.ok(
      control.peak > GOVERNOR_HARD_CAP,
      `[control] Peak ${control.peak} did not exceed the hard cap ${GOVERNOR_HARD_CAP} — the fixture no longer creates real contention (gate is meaningless).`
    );

    console.log(
      `Governor contention stress PASSED (enforced peak ${enforced.peak} <= ${ENFORCED_CEILING} with ${enforced.evictions} eviction(s) + clean recreation; ` +
        `control peak ${control.peak} > ${GOVERNOR_HARD_CAP} proves genuine contention).`
    );
  } finally {
    await stopProcess(vite);
  }
}

async function runStress(url: string): Promise<StressResult> {
  const browser = await launchBrowser();
  const lostContextErrors: string[] = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 600, height: 900 } });
    const capture = (text: string) => {
      if (/lost webgl context|CONTEXT_LOST/i.test(text)) lostContextErrors.push(text);
    };
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error" || type === "warning") process.stdout.write(`[page:${type}] ${text}\n`);
      capture(text);
    });
    page.on("pageerror", (err) => {
      process.stdout.write(`[page:exception] ${err.message}\n`);
      capture(err.message);
    });
    await page.goto(url, { waitUntil: "networkidle" });
    const root = page.locator(".governor-stress-page");
    await root.waitFor({ state: "attached", timeout: 60_000 });
    await page
      .locator(".governor-stress-page[data-render-fixture='ready'], .governor-stress-page[data-render-fixture='error']")
      .waitFor({ state: "attached", timeout: 120_000 });

    const status = await root.getAttribute("data-render-fixture");
    if (status === "error") {
      const detail = await page.locator("[data-stress-error]").textContent().catch(() => null);
      throw new Error(`Governor stress page errored: ${detail ?? "unknown"}`);
    }
    const num = async (attr: string) => Number((await root.getAttribute(attr)) ?? "NaN");
    const flag = async (attr: string) => (await root.getAttribute(attr)) === "1";
    return {
      governor: await flag("data-governor"),
      peak: await num("data-peak-contexts"),
      evictions: await num("data-evictions"),
      recreateFailures: await num("data-recreate-failures"),
      previewFailed: await flag("data-preview-failed"),
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
