/**
 * Color engine comparison harness (Phase 3 WebGL backbone gate).
 * Renders the SAME fixture page through the production DOM/SVG color path
 * (`?colorEngine=dom`) and the new WebGL float/3D-LUT path (`?colorEngine=webgl`), then
 * diffs the two screenshots. The two engines apply the same color math, so a small diff
 * is expected (8-bit SVG vs float LUT); a LARGE diff means a gross error (broken
 * object-fit, wrong channel, dead shader) — that's what this gate catches before WebGL
 * becomes the default. Runs in a real browser/GPU env (CI / local / Docker Playwright
 * image), NOT the restricted sandbox.
 *
 *   pnpm --filter @lumio-by-aelivion/worker color:compare
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDir = path.join(repoRoot, "tmp", "color-engine-compare");
const domPath = path.join(artifactDir, "dom.png");
const webglPath = path.join(artifactDir, "webgl.png");
const diffPath = path.join(artifactDir, "diff.png");
const summaryPath = path.join(artifactDir, "summary.json");

const diffThreshold = Number(process.env.PIXEL_DIFF_THRESHOLD ?? 0.16);
// DOM (8-bit SVG) vs WebGL (float LUT) of the SAME grade: small expected delta; a large
// diff signals a gross error. Generous default; tune via env once baselined.
const maxDiffRatio = Number(process.env.COLOR_ENGINE_MAX_DIFF_RATIO ?? 0.06);

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}/editor/__preview-fixture`;
  const vite = startWebServer(port);
  try {
    await waitForServer(base);
    await capture(`${base}?colorEngine=dom`, domPath);
    await capture(`${base}?colorEngine=webgl`, webglPath, 600); // settle the WebGL draw
  } finally {
    await stopProcess(vite);
  }

  const summary = comparePngs(domPath, webglPath, diffPath);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`DOM frame:   ${domPath}`);
  console.log(`WebGL frame: ${webglPath}`);
  console.log(`Diff image:  ${diffPath}`);
  console.log(`DOM vs WebGL diff: ${(summary.diffRatio * 100).toFixed(3)}% (${summary.diffPixels}/${summary.totalPixels})`);

  if (summary.diffRatio > maxDiffRatio) {
    throw new Error(
      `Color engine comparison failed: ${(summary.diffRatio * 100).toFixed(3)}% differs, max allowed ${(maxDiffRatio * 100).toFixed(3)}% — likely a WebGL render error, not just precision.`
    );
  }
  console.log("Color engine comparison passed (WebGL matches the DOM grade within tolerance).");
}

function startWebServer(port: number) {
  // shell:true so Windows resolves `pnpm` → `pnpm.cmd` (bare spawn is ENOENT; spawning `.cmd`
  // directly is EINVAL on modern Node/Windows). Args are static, so shell:true is safe here.
  const child = spawn(
    "pnpm",
    ["--dir", path.join(repoRoot, "apps/web"), "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, env: { ...process.env, BROWSER: "none" }, stdio: ["ignore", "pipe", "pipe"], shell: true }
  );
  child.stdout.on("data", (data) => process.stdout.write(`[web] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[web] ${data}`));
  return child;
}

async function capture(url: string, outputPath: string, settleMs = 0) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1200, height: 2100 } });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator("[data-render-fixture='ready']").waitFor({ state: "visible" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map((image) =>
          image.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                image.addEventListener("load", () => resolve(), { once: true });
                image.addEventListener("error", () => resolve(), { once: true });
              })
        )
      );
    });
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    await page.locator(".preview-composition-space").screenshot({ animations: "disabled", caret: "hide", omitBackground: false, path: outputPath });
  } finally {
    await browser.close();
  }
}

function comparePngs(aPath: string, bPath: string, outPath: string) {
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  assert.equal(a.width, b.width, "DOM and WebGL frames must be the same width.");
  assert.equal(a.height, b.height, "DOM and WebGL frames must be the same height.");
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: diffThreshold });
  fs.writeFileSync(outPath, PNG.sync.write(diff));
  const totalPixels = a.width * a.height;
  return { width: a.width, height: a.height, threshold: diffThreshold, maxDiffRatio, diffPixels, totalPixels, diffRatio: diffPixels / totalPixels };
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

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
