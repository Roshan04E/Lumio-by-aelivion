/**
 * Phase 2 — Stage 1 parity gate (`media:shared-probe`). POSITIVE CONTROL.
 *
 * Drives `/editor/__media-shared-context-probe`, which renders the SAME source + grade + effects through
 * `MediaWebGLRenderer` in BOTH the existing own-canvas mode and the new shared-context (RenderTarget) mode and
 * compares the readback. They must match — proving the additive shared-context capability is a pixel-safe drop-in
 * for the export's per-clip grade (Stage 2).
 *
 * PASS (exit 0) → shared-context output matches own-canvas (differing RGB < 0.5%, max channel diff ≤ 4).
 * FAIL (exit 1) → outputs diverge, or the probe could not run.
 *
 * Additive + OFF by default; needs real WebGL2 → run with `PIXEL_BROWSER_CHANNEL=chrome`.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_DIFF_PCT = Number(process.env.MEDIA_SHARED_MAX_DIFF_PCT ?? 0.5);
const MAX_CHANNEL_DIFF = Number(process.env.MEDIA_SHARED_MAX_CHANNEL_DIFF ?? 4);

async function main() {
  console.log(`Phase 2 Stage 1 parity gate: MediaWebGLRenderer shared-context vs own-canvas (≤ ${MAX_DIFF_PCT}% RGB, ≤ ${MAX_CHANNEL_DIFF}/channel)`);
  const port = await getFreePort();
  const vite = startWebServer(port);
  try {
    const base = `http://127.0.0.1:${port}/editor/__media-shared-context-probe`;
    await waitForServer(base);
    const result = await runProbe(base);

    console.log(`diffPct=${result.diffPct}% maxChannelDiff=${result.maxChannelDiff} state=${result.state}`);
    if (result.state === "error") throw new Error(`probe page errored: ${result.error}`);
    assert.ok(
      result.diffPct <= MAX_DIFF_PCT && result.maxChannelDiff <= MAX_CHANNEL_DIFF,
      `shared-context output diverged from own-canvas (diffPct=${result.diffPct}%, maxChannelDiff=${result.maxChannelDiff}) — not a pixel-safe drop-in.`
    );
    console.log(`media:shared-probe PASSED — shared-context output matches own-canvas (diffPct=${result.diffPct}%, maxChannelDiff=${result.maxChannelDiff}).`);
  } finally {
    await stopProcess(vite);
  }
}

interface ProbeResult {
  state: string;
  diffPct: number;
  maxChannelDiff: number;
  error: string;
}

async function runProbe(url: string): Promise<ProbeResult> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 400, height: 400 } });
    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error" || msg.type() === "warning") process.stdout.write(`[page:${msg.type()}] ${text}\n`);
      else if (text.startsWith("[media-probe]")) process.stdout.write(`${text}\n`);
    });
    page.on("pageerror", (err) => process.stdout.write(`[page:exception] ${err.message}\n`));

    await page.goto(url, { waitUntil: "networkidle" });
    const root = page.locator(".media-shared-context-probe-page");
    await root.waitFor({ state: "attached", timeout: 60_000 });
    await page
      .locator(".media-shared-context-probe-page[data-probe-state='ready'], .media-shared-context-probe-page[data-probe-state='error']")
      .waitFor({ state: "attached", timeout: 60_000 });

    const state = (await root.getAttribute("data-probe-state")) ?? "unknown";
    const error = (await page.locator("[data-probe-error]").textContent().catch(() => "")) ?? "";
    return {
      state,
      diffPct: Number((await root.getAttribute("data-diff-pct")) ?? "NaN"),
      maxChannelDiff: Number((await root.getAttribute("data-max-channel-diff")) ?? "NaN"),
      error,
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

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
