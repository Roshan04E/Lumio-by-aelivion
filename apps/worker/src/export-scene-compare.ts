/**
 * Local-export compositor parity gate (Method 3, Phase 5 — `export:compare:scene`).
 *
 * Renders each fixture twice through the in-browser export fixture page (`/editor/__export-fixture`) — once
 * with `?exportCompositor=frame` (the proven canvas2D `FrameCompositor`) and once with
 * `?exportCompositor=scene` (the new GPU `SceneFrameCompositor`, shared with the editor preview) — and
 * asserts the two composited frames match within a small threshold. This is the gate that lets the export
 * default flip from "frame" to "scene": the scene export must reproduce the export the user already trusts.
 *
 * Sibling of `scene-compositor-compare.ts` (preview DOM↔scene) and `render-pixel-comparison.ts`
 * (preview↔Remotion); same standalone-script convention (asserts + exits non-zero), same fixture set.
 *
 * EXCLUDED fixtures, two reasons — both cases where the scene export is the UPGRADE, not a regression, so
 * "scene == frame" is the wrong assertion:
 *   1. `blur`/`glow`/`region-blur`/`masked-blur`: `FrameCompositor` renders NO blur/glow — that canvas2D
 *      gap is one of the things Phase 5 FIXES — so the scene export adds the missing effect.
 *   2. `tilt-3d`: `FrameCompositor` projects 3D-tilted MEDIA via `Quad3DCompositor`, a DIFFERENT
 *      perspective projection than `SceneCompositor`'s in-pass 3D quad. The SCENE one is canonical —
 *      gate-locked to DOM by `scene:compare` (tilt-3d **0.117%** scene↔DOM) and to Remotion by
 *      `render:compare:pixels` (~0.62% DOM↔Remotion); `Quad3DCompositor` was never in that chain. The two
 *      diverge ~4% at the foreshortened (receding) edge, full-frame coverage amplifying it. Asserting
 *      scene==frame here would lock in the OUTGOING impl's error. (`tilted-text` stays in — it's the same
 *      divergence but tiny text-box coverage keeps it ~0.3%, and it adds text grade/raster/placement cover.)
 * All excluded effects/cases are gate-locked by `scene:compare` (scene preview ≈ DOM), and the scene EXPORT
 * shares that exact `buildSceneDraws` + `SceneCompositor` code, so they're covered. This gate proves parity
 * on everything `FrameCompositor` renders correctly — media, object-fit, opacity, blend, grade, clip/region
 * masks, text/shape, captions, junction transitions, and (via tilted-text) the 3D text path.
 *
 * NOTE: both compositors need a real WebGL2 GPU (MediaWebGLRenderer grade + the SceneCompositor pass) and
 * WebCodecs/createImageBitmap decode. Run with `PIXEL_BROWSER_CHANNEL=chrome` on a GPU machine; bundled
 * Chromium lacks WebGL2 and would render nothing (a meaningless ~0% diff).
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderComparisonFixtureKeys, type RenderComparisonFixtureKey } from "@reelforge/shared";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDir = path.join(repoRoot, "tmp", "export-scene-compare");

const diffThreshold = Number(process.env.PIXEL_DIFF_THRESHOLD ?? 0.16);

// Both export compositors run drawTextLayer for text/shape + MediaWebGLRenderer for grade, so the diff is
// pure composite-engine difference (GPU quad vs canvas2D drawImage) — AA along edges, ~the scene:compare
// floor. Generous on the first run; TUNE to the observed values on the first GPU run (mirrors how
// scene-compositor-compare.ts was seeded).
const maxDiffRatio = Number(process.env.EXPORT_SCENE_MAX_DIFF_RATIO ?? 0.012);

// Excluded: cases where scene is the canonical UPGRADE over frame (see header). blur/glow — frame lacks
// the effect; tilt-3d — frame's Quad3DCompositor 3D projection diverges from the canonical SceneCompositor
// quad (scene↔DOM locked at 0.117% by scene:compare). "scene == frame" is wrong for these.
const GATE_EXCLUDED = new Set<RenderComparisonFixtureKey>(["blur", "glow", "region-blur", "masked-blur", "tilt-3d"]);

// Per-fixture overrides where the two engines legitimately differ a touch more (AA on tilted/magnified
// edges, the transition mix). A real regression — a dropped layer, wrong grade/mask, mis-placed text —
// diffs a whole region and blows past these.
const fixtureMaxDiff: Partial<Record<RenderComparisonFixtureKey, number>> = {
  "scaled-text": 0.008,
  "graded-text": 0.01,
  "masked-text": 0.01,
  "region-text": 0.012,
  "tilted-text": 0.012,
  transition: 0.008,
};

const fixtureKeys: RenderComparisonFixtureKey[] = (() => {
  const raw = process.env.PIXEL_FIXTURES;
  const base = renderComparisonFixtureKeys.filter((k) => !GATE_EXCLUDED.has(k));
  if (!raw) return base;
  const requested = raw.split(",").map((v) => v.trim()).filter(Boolean);
  const valid = requested.filter((v): v is RenderComparisonFixtureKey =>
    renderComparisonFixtureKeys.includes(v as RenderComparisonFixtureKey)
  );
  if (!valid.length) throw new Error(`PIXEL_FIXTURES had no known fixtures. Known: ${renderComparisonFixtureKeys.join(", ")}`);
  return valid;
})();

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  // Phase 2 Stage 2: with EXPORT_SINGLE_CONTEXT=1 the scene capture runs the single-context export path
  // (media + overlay graded into shared-context RTTs) — so the SAME parity thresholds prove it's a drop-in.
  const singleCtxOverride = process.env.EXPORT_SINGLE_CONTEXT;
  const singleCtx = singleCtxOverride != null ? `&exportSingleContext=${encodeURIComponent(singleCtxOverride)}` : "";
  const singleCtxLabel = singleCtxOverride == null ? "single-context default" : `exportSingleContext=${singleCtxOverride}`;
  console.log(`Export compositor parity: comparing exportCompositor=scene (${singleCtxLabel}) vs exportCompositor=frame`);
  console.log(`Fixtures: ${fixtureKeys.join(", ")}`);

  const port = await getFreePort();
  const vite = startWebServer(port);
  const failures: string[] = [];
  try {
    const baseUrl = `http://127.0.0.1:${port}/editor/__export-fixture`;
    await waitForServer(baseUrl);
    for (const key of fixtureKeys) {
      const fixture = `fixture=${encodeURIComponent(key)}`;
      const framePath = path.join(artifactDir, `frame-${key}.png`);
      const scenePath = path.join(artifactDir, `scene-${key}.png`);
      const diffPath = path.join(artifactDir, `diff-${key}.png`);
      await captureExportFrame(`${baseUrl}?${fixture}&exportCompositor=frame`, framePath);
      await captureExportFrame(`${baseUrl}?${fixture}&exportCompositor=scene${singleCtx}`, scenePath);
      const summary = comparePngs(framePath, scenePath, diffPath);
      const limit = fixtureMaxDiff[key] ?? maxDiffRatio;
      const pct = (summary.diffRatio * 100).toFixed(3);
      console.log(`[${key}] diff ${pct}% (limit ${(limit * 100).toFixed(2)}%) (${summary.diffPixels}/${summary.totalPixels}) → ${diffPath}`);
      if (summary.diffRatio > limit) failures.push(`${key}: ${pct}% > ${(limit * 100).toFixed(3)}%`);
    }
  } finally {
    await stopProcess(vite);
  }

  if (failures.length) {
    throw new Error(`Export compositor parity failed for ${failures.length} fixture(s):\n  ${failures.join("\n  ")}`);
  }
  console.log(`Export compositor parity passed for all ${fixtureKeys.length} fixture(s).`);
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

async function captureExportFrame(url: string, outputPath: string) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1200, height: 2100 } });
    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning") process.stdout.write(`[page:${type}] ${msg.text()}\n`);
    });
    page.on("pageerror", (err) => process.stdout.write(`[page:exception] ${err.message}\n`));
    await page.goto(url, { waitUntil: "networkidle" });
    // The page sets data-render-fixture='ready' once the chosen compositor has rendered the frame; if the
    // export throws it becomes 'error' (surfaced via the forwarded console) and this wait times out.
    await page.locator("[data-render-fixture='ready']").waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.waitForTimeout(150);
    await page.locator(".export-fixture-page canvas").screenshot({
      animations: "disabled",
      caret: "hide",
      omitBackground: false,
      path: outputPath,
    });
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

function comparePngs(aPath: string, bPath: string, diffPath: string) {
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  assert.equal(a.width, b.width, "frame and scene captures must match width.");
  assert.equal(a.height, b.height, "frame and scene captures must match height.");
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: diffThreshold });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  const totalPixels = a.width * a.height;
  return { diffPixels, totalPixels, diffRatio: diffPixels / totalPixels };
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
