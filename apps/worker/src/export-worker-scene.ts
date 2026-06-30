/**
 * Phase 2 — Stage 3 gate (`export:worker-scene`). POSITIVE control.
 *
 * Drives `/editor/__export-worker-scene`, which renders a bloom/blur/grade VIDEO fixture on the MAIN thread
 * via the SINGLE-CONTEXT `SceneFrameCompositor` (reference) and then runs the SAME single-context scene export
 * THROUGH THE REAL export Worker (`exportCompositor:"scene"` + `exportSingleContext:true`) — the exact input
 * `local-export.ts` threads when Stage 3 routing is enabled — comparing the two across the timeline, repeated.
 *
 * This is the proof that Phase 2 works: the single self-contained WebGL2 context survives the Worker's isolated
 * GPU process, where the legacy multi-/cross-context scene path black-frames (the Stage 0 negative probe).
 *
 * Asserts (all must hold for exit 0):
 *   - export COMPLETES every run (no worker throw / timeout),
 *   - NO black frames in the worker output,
 *   - NO "lost WebGL context" console line (page or worker),
 *   - NO scene→canvas2D fallback console line (export-core's "falling back to frame compositor", or
 *     local-export's "falling back to main-thread scene") — the worker scene path must hold on its own,
 *   - output luma-parity vs the main-thread single-context reference within the fallback diff budget.
 *
 * Parity is luma-tolerant because the reference is an uncompressed canvas render and the worker output is a
 * lossy H.264 MP4 — exact-pixel parity of the scene compositor itself is gate-locked by `scene:compare`
 * (scene preview vs DOM), which transitively covers the export since it shares the preview's draw-list +
 * compositor. (This is the permanent export parity gate; the `export:compare:scene` frame↔scene migration
 * scaffold was retired with the canvas2D FrameCompositor in Phase 5.)
 *
 * Changes NO default behavior (hidden route + its own Worker; `local-export.ts` default routing untouched).
 * Needs real WebGL2 (main + worker) + WebCodecs → run with `PIXEL_BROWSER_CHANNEL=chrome`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLIPS = Number(process.env.WORKER_SCENE_CLIPS ?? 24);
const RUNS = Number(process.env.WORKER_SCENE_RUNS ?? 2);
const GATE_TIMEOUT_MS = Number(process.env.WORKER_SCENE_GATE_TIMEOUT_MS ?? 120_000);

async function main() {
  console.log(`Phase 2 Stage 3 gate (POSITIVE): single-context VIDEO scene export through the Worker vs main-thread reference — ${CLIPS} clips × ${RUNS} runs`);
  let vite: ChildProcess | null = null;
  try {
    await withTimeout(async () => {
    const port = await getFreePort();
    vite = startWebServer(port);
    const base = `http://127.0.0.1:${port}/editor/__export-worker-scene`;
    await waitForServer(base);
    const result = await runGate(`${base}?clips=${CLIPS}&runs=${RUNS}`);

    console.log("");
    console.log(`pass             = ${result.pass}`);
    console.log(`detail           = ${result.detail}`);
    console.log(`ref luma         = ${result.refLuma}`);
    console.log(`worker luma      = ${result.workerLuma}`);
    console.log(`max diff %       = ${result.maxDiff}`);
    console.log(`black events     = ${result.blackEvents}`);
    console.log(`runs done        = ${result.runsDone} / ${RUNS}`);
    console.log(`duration exp/act = ${result.durExpected}s / ${result.durActual}s`);
    if (result.lostContextLines.length) {
      console.log(`lost-context console lines (${result.lostContextLines.length}):`);
      for (const line of result.lostContextLines) console.log(`  ${line}`);
    }
    if (result.fallbackLines.length) {
      console.log(`scene-fallback console lines (${result.fallbackLines.length}):`);
      for (const line of result.fallbackLines) console.log(`  ${line}`);
    }
    if (result.stageProbeLines.length) {
      console.log(`worker stage probe lines (${result.stageProbeLines.length}):`);
      for (const line of result.stageProbeLines) console.log(`  ${line}`);
    }
    console.log("");

    const failures: string[] = [];
    if (result.state !== "ready") failures.push(`gate page did not reach 'ready' (state=${result.state})`);
    if (result.pass !== "pass") failures.push(`gate verdict not pass: ${result.detail}`);
    if (Number(result.blackEvents) > 0) failures.push(`${result.blackEvents} black frame(s) in worker output`);
    if (Number(result.runsDone) < RUNS) failures.push(`only ${result.runsDone}/${RUNS} worker exports completed`);
    if (result.lostContextLines.length) failures.push(`${result.lostContextLines.length} lost-WebGL-context console line(s)`);
    if (result.fallbackLines.length) failures.push(`${result.fallbackLines.length} scene-fallback console line(s) (worker scene degraded to canvas2D / main-thread)`);

    if (failures.length) {
      console.log(`GATE FAIL — Worker single-context scene export did not hold:`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log(`GATE PASS — Worker single-context scene export completed cleanly across ${RUNS} run(s): no black frames, no lost context, no fallback, parity within budget (maxDiff=${result.maxDiff}%).`);
    process.exitCode = 0;
    }, GATE_TIMEOUT_MS, `export:worker-scene exceeded ${GATE_TIMEOUT_MS}ms`);
  } finally {
    if (vite) await stopProcess(vite);
  }
}

interface GateResult {
  state: string;
  pass: string;
  detail: string;
  refLuma: string;
  workerLuma: string;
  maxDiff: string;
  blackEvents: string;
  runsDone: string;
  durExpected: string;
  durActual: string;
  lostContextLines: string[];
  fallbackLines: string[];
  stageProbeLines: string[];
}

async function runGate(url: string): Promise<GateResult> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const lostContextLines: string[] = [];
  const fallbackLines: string[] = [];
  const stageProbeLines: string[] = [];
  let guardFailureDetail = "";
  try {
    browser = await launchBrowser();
    context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 600, height: 900 } });
    page = await context.newPage();
    let resolveGuardFailure: (() => void) | null = null;
    const guardFailure = new Promise<void>((resolve) => {
      resolveGuardFailure = resolve;
    });
    const capture = (text: string) => {
      if (/lost webgl context|context lost|webglcontextlost/i.test(text)) lostContextLines.push(text);
      if (text.startsWith("[worker-scene-stage]")) stageProbeLines.push(text);
      if (text.includes("WORKER_SCENE_BLACK_FRAME_GUARD")) {
        guardFailureDetail = text;
        resolveGuardFailure?.();
      }
      // export-core: "[export] scene compositor failed ... falling back to frame compositor"
      // local-export: "worker scene export failed, falling back to main-thread scene"
      if (/falling back to frame compositor|falling back to main-thread scene|scene compositor (construction )?failed/i.test(text)) {
        fallbackLines.push(text);
      }
    };
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error" || type === "warning") process.stdout.write(`[page:${type}] ${text}\n`);
      else if (text.startsWith("[worker-scene]") || text.startsWith("[worker-scene-stage]") || text.startsWith("[export")) process.stdout.write(`${text}\n`);
      capture(text);
    });
    page.on("pageerror", (err) => {
      process.stdout.write(`[page:exception] ${err.message}\n`);
      capture(err.message);
    });

    await page.goto(url, { waitUntil: "networkidle" });
    const root = page.locator(".export-worker-scene-page");
    await root.waitFor({ state: "attached", timeout: 60_000 });
    const readyOrError = page
      .locator(".export-worker-scene-page[data-gate-state='ready'], .export-worker-scene-page[data-gate-state='error']")
      .waitFor({ state: "attached", timeout: GATE_TIMEOUT_MS });
    await Promise.race([readyOrError, guardFailure]);

    const state = (await root.getAttribute("data-gate-state")) ?? "";
    if (guardFailureDetail && state !== "ready" && state !== "error") {
      return {
        state: "ready",
        pass: "fail",
        detail: guardFailureDetail,
        refLuma: (await root.getAttribute("data-ref-luma")) ?? "0",
        workerLuma: "0",
        maxDiff: "0",
        blackEvents: "1",
        runsDone: (await root.getAttribute("data-runs-done")) ?? "0",
        durExpected: (await root.getAttribute("data-duration-expected")) ?? "0",
        durActual: "0",
        lostContextLines,
        fallbackLines,
        stageProbeLines,
      };
    }
    if (state === "error") {
      const detail = await page.locator("[data-gate-error]").textContent().catch(() => null);
      return { state, pass: "fail", detail: `gate page errored: ${detail ?? "unknown"}`, refLuma: "0", workerLuma: "0", maxDiff: "0", blackEvents: "0", runsDone: "0", durExpected: "0", durActual: "0", lostContextLines, fallbackLines, stageProbeLines };
    }
    const attr = async (name: string) => (await root.getAttribute(name)) ?? "";
    const detail = (await page.locator("[data-gate-detail]").textContent().catch(() => "")) ?? "";
    return {
      state,
      pass: await attr("data-pass"),
      detail,
      refLuma: await attr("data-ref-luma"),
      workerLuma: await attr("data-worker-luma"),
      maxDiff: await attr("data-max-diff"),
      blackEvents: await attr("data-black-events"),
      runsDone: await attr("data-runs-done"),
      durExpected: await attr("data-duration-expected"),
      durActual: await attr("data-duration-actual"),
      lostContextLines,
      fallbackLines,
      stageProbeLines,
    };
  } finally {
    await closeQuietly(() => page?.close());
    await closeQuietly(() => context?.close());
    await closeQuietly(() => browser?.close());
  }
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeQuietly(fn: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    /* cleanup best effort */
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
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
