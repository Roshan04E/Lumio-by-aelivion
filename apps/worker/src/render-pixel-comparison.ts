import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderManifest } from "@orreris/render-templates";
import {
  createRenderComparisonFixture,
  renderComparisonArtifactDir,
  renderComparisonFixtureKeys,
  renderComparisonFrameSeconds,
  type RenderComparisonFixtureKey
} from "@orreris/shared";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { renderManifestStill } from "./remotion-renderer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDir = path.join(repoRoot, "tmp", renderComparisonArtifactDir);
const diffSummaryPath = path.join(artifactDir, "summary.json");

const diffThreshold = Number(process.env.PIXEL_DIFF_THRESHOLD ?? 0.16);
const maxDiffRatio = Number(process.env.PIXEL_MAX_DIFF_RATIO ?? 0.035);

// PER-FIXTURE BARS (2026-07-28). One global 3.5% has to be sized for the LOOSEST fixture in the
// sweep, which leaves it meaningless for the tight ones. Measured: the whole visual footprint of the
// v32i merge-blend fix was 1.43%, so the ASYMMETRIC form of that bug — the fix reaching one renderer
// and not the other — would have read 1.43% < 3.5% and PASSED on the very fixture built to catch it.
// A fixture's bar should reflect what that fixture actually achieves, not the worst case anywhere.
//
// Values are set from an observed full sweep with real headroom, never just above the reading: every
// entry here measured 0.000% (0-3 pixels of 2073600), so 0.5% leaves ~10000 pixels of slack. The
// web-preview capture is not byte-deterministic run to run (see v32m: max channel delta 8/255), but
// that jitter sits under pixelmatch's perceptual `threshold` and contributes ~0 differing pixels.
//
// Deliberately NOT listed: `flarex-generators` (0.691% — procedural generator noise is genuinely
// non-deterministic across renderers) and `advanced-transition` (3.131%, already at 89% of the global
// budget). Both keep the loose global bar until someone investigates why they need it.
//
// An explicit PIXEL_MAX_DIFF_RATIO overrides every per-fixture bar — the escape hatch for a machine
// whose GPU rasterizes differently enough to make the tight bars flaky.
const fixtureMaxDiffRatio: Partial<Record<RenderComparisonFixtureKey, number>> = {
  "flarex-key-glow": 0.005,
  "flarex-curves": 0.005,
  "flarex-keyframed-blur": 0.005,
  "flarex-merge-blend": 0.005,
  "flarex-transform": 0.005,
  "flarex-ellipse-matte": 0.005,
  "flarex-reroute": 0.005,
  "flarex-multi-in": 0.005,
  "flarex-color-chain": 0.005,
  "flarex-unified-color": 0.005,
  "flarex-filter-stack": 0.005
};

function barFor(key: RenderComparisonFixtureKey): number {
  if (process.env.PIXEL_MAX_DIFF_RATIO) return maxDiffRatio;
  return fixtureMaxDiffRatio[key] ?? maxDiffRatio;
}

// Which render path the harness exercises (default: the unified WebGL path — the one this
// comparison was built to verify). `legacy` re-checks the pre-WebGL DOM path for regressions.
const rendererMode: "legacy" | "webgl" = process.env.RENDERER_MODE === "legacy" ? "legacy" : "webgl";

// Which fixtures to sweep. Default: all variants. Override with PIXEL_FIXTURES=plain-image,matte.
const fixtureKeys: RenderComparisonFixtureKey[] = (() => {
  const raw = process.env.PIXEL_FIXTURES;
  if (!raw) return renderComparisonFixtureKeys;
  const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const valid = requested.filter((value): value is RenderComparisonFixtureKey =>
    renderComparisonFixtureKeys.includes(value as RenderComparisonFixtureKey)
  );
  if (!valid.length) throw new Error(`PIXEL_FIXTURES had no known fixtures. Known: ${renderComparisonFixtureKeys.join(", ")}`);
  return valid;
})();

interface FixtureResult {
  fixture: RenderComparisonFixtureKey;
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  renderFramePath: string;
  previewFramePath: string;
  diffFramePath: string;
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  console.log(`Render path under test: rendererMode=${rendererMode}`);
  console.log(`Fixtures: ${fixtureKeys.join(", ")}`);

  // Render every Remotion still up front (each blocks on its own WebGL frame), then spin one
  // vite server to capture all web-preview frames, then diff each pair.
  const stills = new Map<RenderComparisonFixtureKey, string>();
  for (const key of fixtureKeys) {
    const fixture = createRenderComparisonFixture(key);
    assert.ok(fixture.graph.composition, `Fixture "${key}" must include a composition.`);
    const manifest = buildRenderManifest({
      projectId: fixture.graph.projectId,
      graph: fixture.graph,
      assets: fixture.assets,
      quality: "final",
      createdAt: new Date(0).toISOString()
    });
    const frame = Math.round(renderComparisonFrameSeconds * manifest.output.fps);
    const renderFramePath = path.join(artifactDir, `remotion-${key}.png`);
    await renderManifestStill({ manifest, frame, outputLocation: renderFramePath, rendererMode });
    stills.set(key, renderFramePath);
  }

  const port = await getFreePort();
  const vite = startWebServer(port);
  const previews = new Map<RenderComparisonFixtureKey, string>();
  try {
    const baseUrl = `http://127.0.0.1:${port}/editor/__preview-fixture`;
    await waitForServer(baseUrl);
    for (const key of fixtureKeys) {
      const url = `${baseUrl}?fixture=${encodeURIComponent(key)}&rendererMode=${rendererMode}`;
      const previewFramePath = path.join(artifactDir, `web-preview-${key}.png`);
      await capturePreviewFrame(url, previewFramePath);
      previews.set(key, previewFramePath);
    }
  } finally {
    await stopProcess(vite);
  }

  const results: FixtureResult[] = [];
  const failures: string[] = [];
  for (const key of fixtureKeys) {
    const renderFramePath = stills.get(key)!;
    const previewFramePath = previews.get(key)!;
    const diffFramePath = path.join(artifactDir, `diff-${key}.png`);
    const bar = barFor(key);
    const summary = comparePngs(renderFramePath, previewFramePath, diffFramePath, bar);
    results.push({ fixture: key, renderFramePath, previewFramePath, diffFramePath, ...summary });
    const pct = (summary.diffRatio * 100).toFixed(3);
    console.log(`[${key}] diff ${pct}% (${summary.diffPixels}/${summary.totalPixels}) → ${diffFramePath}`);
    if (summary.diffRatio > bar) {
      failures.push(`${key}: ${pct}% > ${(bar * 100).toFixed(3)}%`);
    }
  }

  // MERGE, don't replace. `PIXEL_FIXTURES=<one>` used to rewrite the summary with only the fixture it
  // ran, silently discarding the other 52 entries — a scoped run is a narrower question about the
  // same sweep, not a new sweep. Entries this run re-measured win; entries it did not touch survive.
  // A `rendererMode` change DOES invalidate the rest, since the old results describe a different
  // render path, so that case starts clean.
  const previous = readPreviousResults();
  const merged = new Map<string, FixtureResult>();
  for (const result of previous) merged.set(result.fixture, result);
  for (const result of results) merged.set(result.fixture, result);
  const mergedResults = [...merged.values()];

  fs.writeFileSync(
    diffSummaryPath,
    `${JSON.stringify(
      { rendererMode, maxDiffRatio, threshold: diffThreshold, results: mergedResults },
      null,
      2
    )}\n`
  );

  if (failures.length) {
    throw new Error(`Pixel comparison failed for ${failures.length} fixture(s):\n  ${failures.join("\n  ")}`);
  }

  console.log(`Pixel comparison passed for all ${results.length} fixture(s).`);
}

function startWebServer(port: number) {
  // shell:true so Windows resolves `pnpm` → `pnpm.cmd`. Bare `spawn("pnpm")` is ENOENT, and spawning
  // `pnpm.cmd` directly is EINVAL on modern Node/Windows (CVE-2024-27980 hardening) — a shell is
  // required for `.cmd`. The args are static (no interpolation), so shell:true is safe here despite
  // the DEP0190 notice.
  const child = spawn("pnpm", ["--dir", path.join(repoRoot, "apps/web"), "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: repoRoot,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true
  });

  child.stdout.on("data", (data) => process.stdout.write(`[web] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[web] ${data}`));

  return child;
}

async function capturePreviewFrame(url: string, outputPath: string) {
  // PIXEL_BROWSER_CHANNEL lets a dev without the Playwright-managed Chromium fall back to an
  // installed channel ("msedge"/"chrome"); default uses the bundled Chromium.
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { width: 1200, height: 2100 }
    });
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

    // Give the scene compositor's rAF a couple frames to paint its first result (same settle its
    // sibling gate scene-compositor-compare.ts always had). Without it the screenshot races the first
    // GPU present and randomly captures a BLACK canvas (~88% diff on arbitrary fixtures per run —
    // verified 2026-07-07: failing web captures meanLuma≈0 vs remotion≈110, differing fixture sets
    // across identical-code runs). Capture-sync only; thresholds and rendering are untouched.
    await page.waitForTimeout(250);

    await page.locator(".preview-composition-space").screenshot({
      animations: "disabled",
      caret: "hide",
      omitBackground: false,
      path: outputPath
    });
  } finally {
    await browser.close();
  }
}

// Reads the results of the previous sweep so a scoped run can merge into them rather than replace
// them. Any unreadable/malformed/foreign-rendererMode summary yields [] — a broken file must not fail
// the gate, it just means this run starts from nothing.
function readPreviousResults(): FixtureResult[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(diffSummaryPath, "utf8")) as {
      rendererMode?: string;
      results?: FixtureResult[];
    };
    if (parsed.rendererMode !== rendererMode) return [];
    if (!Array.isArray(parsed.results)) return [];
    return parsed.results.filter((result) => typeof result?.fixture === "string");
  } catch {
    return [];
  }
}

function comparePngs(renderPath: string, previewPath: string, diffPath: string, bar: number) {
  const render = PNG.sync.read(fs.readFileSync(renderPath));
  const preview = PNG.sync.read(fs.readFileSync(previewPath));

  assert.equal(preview.width, render.width, "Preview width must match Remotion render width.");
  assert.equal(preview.height, render.height, "Preview height must match Remotion render height.");

  const diff = new PNG({ width: render.width, height: render.height });
  const diffPixels = pixelmatch(render.data, preview.data, diff.data, render.width, render.height, {
    threshold: diffThreshold
  });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = render.width * render.height;
  return {
    width: render.width,
    height: render.height,
    frameSeconds: renderComparisonFrameSeconds,
    threshold: diffThreshold,
    // The bar this fixture was actually judged against, not the global default — otherwise the
    // summary reports a number the gate never used.
    maxDiffRatio: bar,
    diffPixels,
    totalPixels,
    diffRatio: diffPixels / totalPixels
  };
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not find a free port."));
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
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for web server. Last error: ${String(lastError)}`);
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) {
    return;
  }

  // On Windows the vite server is spawned via `shell:true`, so `child` is the cmd wrapper — SIGTERM to it
  // leaves the real vite node process (and its ChildProcess handle) alive, which keeps this process's event
  // loop open after `main()` resolves (the teardown hang). `taskkill /T /F` kills the whole tree. Mirrors the
  // sibling export gates (export-worker-scene.ts / export-scene-compare.ts).
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

// Exit explicitly once the verdict is printed. The render + diff work is done by then, so a lingering handle
// (e.g. a vite child that outlived teardown) must not keep the process alive — `stopProcess` already tore the
// server down. Mirrors export-worker-scene.ts.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
