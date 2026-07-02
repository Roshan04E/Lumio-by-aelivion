/**
 * Phase 2 — Stage 0 diagnostic gate (`export:worker-scene-probe`). NEGATIVE CONTROL.
 *
 * Drives `/editor/__export-worker-scene-probe`, which renders frame 0 of a bloom/blur/grade fixture on the
 * MAIN thread via the legacy multi-context `SceneFrameCompositor` (known-good reference) and then runs the SAME
 * legacy scene export THROUGH THE REAL export Worker (`exportCompositor:"scene"`), comparing the two.
 *
 * This is a NEGATIVE CONTROL, so the pass/fail polarity is INVERTED vs a normal gate:
 *   - PASS (exit 0)  → the legacy Worker scene export FAILED as expected (black / canvas2D fallback / GL error).
 *                      That justifies Phase 2 Stage 1 (single shared export GL context).
 *   - FAIL (exit 1)  → the probe could not run, errored unrelatedly, OR legacy Worker scene UNEXPECTEDLY worked
 *                      (premise not reproduced — revisit the plan before refactoring).
 *
 * It changes NO default behavior: it drives a hidden diagnostic route + its own Worker; `local-export.ts`
 * routing, `MediaWebGLRenderer`, `FrameCompositor`, and the editor preview are untouched. Not wired into any
 * aggregate test script. Needs real WebGL2 + WebCodecs → run with `PIXEL_BROWSER_CHANNEL=chrome`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLIPS = Number(process.env.PROBE_CLIPS ?? 24);
const RUNS = Number(process.env.PROBE_RUNS ?? 2);

async function main() {
  console.log(`Phase 2 Stage 0 probe (NEGATIVE CONTROL): legacy VIDEO scene export, main-thread reference vs Worker — ${CLIPS} clips × ${RUNS} runs`);
  const port = await getFreePort();
  const vite = startWebServer(port);
  try {
    const base = `http://127.0.0.1:${port}/editor/__export-worker-scene-probe`;
    await waitForServer(base);
    const result = await runProbe(`${base}?clips=${CLIPS}&runs=${RUNS}`);

    console.log("");
    console.log(`verdict          = ${result.verdict}`);
    console.log(`detail           = ${result.detail}`);
    console.log(`ref luma         = ${result.refLuma}`);
    console.log(`worker luma      = ${result.workerLuma}`);
    console.log(`max diff %       = ${result.maxDiff}`);
    console.log(`black events     = ${result.blackEvents}`);
    console.log(`duration exp/act = ${result.durExpected}s / ${result.durActual}s`);
    if (result.workerError) console.log(`worker error     = ${result.workerError}`);
    if (result.lostContextLines.length) {
      console.log(`lost-context console lines (${result.lostContextLines.length}):`);
      for (const line of result.lostContextLines) console.log(`  ${line}`);
    }
    console.log("");

    const reproduced = result.verdict.startsWith("reproduced");
    if (reproduced) {
      console.log(`PROBE PASS — legacy Worker scene export FAILED as expected (${result.verdict}). Phase 2 Stage 1 is justified.`);
      process.exit(0);
    }
    console.log(`PROBE FAIL — ${result.verdict}: ${result.detail}`);
    process.exit(1);
  } finally {
    await stopProcess(vite);
  }
}

interface ProbeResult {
  verdict: string;
  detail: string;
  refLuma: string;
  workerLuma: string;
  maxDiff: string;
  blackEvents: string;
  durExpected: string;
  durActual: string;
  workerError: string;
  lostContextLines: string[];
}

async function runProbe(url: string): Promise<ProbeResult> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const lostContextLines: string[] = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 600, height: 900 } });
    const capture = (text: string) => {
      if (/lost webgl context|context lost|webglcontextlost/i.test(text)) lostContextLines.push(text);
    };
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error" || type === "warning") process.stdout.write(`[page:${type}] ${text}\n`);
      else if (text.startsWith("[probe]") || text.startsWith("[export")) process.stdout.write(`${text}\n`);
      capture(text);
    });
    page.on("pageerror", (err) => {
      process.stdout.write(`[page:exception] ${err.message}\n`);
      capture(err.message);
    });

    await page.goto(url, { waitUntil: "networkidle" });
    const root = page.locator(".export-worker-scene-probe-page");
    await root.waitFor({ state: "attached", timeout: 60_000 });
    await page
      .locator(".export-worker-scene-probe-page[data-probe-state='ready'], .export-worker-scene-probe-page[data-probe-state='error']")
      .waitFor({ state: "attached", timeout: 540_000 });

    const state = await root.getAttribute("data-probe-state");
    if (state === "error") {
      const detail = await page.locator("[data-probe-error]").textContent().catch(() => null);
      return { verdict: "cannot-run", detail: `probe page errored: ${detail ?? "unknown"}`, refLuma: "0", workerLuma: "0", maxDiff: "0", blackEvents: "0", durExpected: "0", durActual: "0", workerError: "", lostContextLines };
    }
    const attr = async (name: string) => (await root.getAttribute(name)) ?? "";
    const detail = (await page.locator("[data-probe-detail]").textContent().catch(() => "")) ?? "";
    return {
      verdict: await attr("data-verdict"),
      detail,
      refLuma: await attr("data-ref-luma"),
      workerLuma: await attr("data-worker-luma"),
      maxDiff: await attr("data-max-diff"),
      blackEvents: await attr("data-black-events"),
      durExpected: await attr("data-duration-expected"),
      durActual: await attr("data-duration-actual"),
      workerError: await attr("data-worker-error"),
      lostContextLines,
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
