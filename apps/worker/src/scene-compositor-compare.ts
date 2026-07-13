/**
 * Single GPU compositor parity gate (Method 3, Phase 1).
 *
 * Captures each preview fixture twice from the SAME page — once with `?compositor=dom` (the shipped
 * DOM path) and once with `?compositor=scene` (the new `SceneCompositor`) — and asserts the two frames
 * match within a small pixel threshold. This is the gate that lets the scene path flip from OFF to the
 * default: it must reproduce the DOM preview pixel-for-pixel before it replaces it.
 *
 * Sibling of `render-pixel-comparison.ts` (preview↔Remotion) and `color-engine-compare.ts`
 * (DOM↔WebGL grade); same fixture page, same standalone-script convention (asserts + exits non-zero).
 *
 * NOTE: needs a real WebGL2 GPU. If the headless browser lacks WebGL2, `useSceneCompositor` returns
 * false and the scene capture silently falls back to the DOM path — the diff would then be ~0% but
 * would prove nothing. Run with `PIXEL_BROWSER_CHANNEL=chrome` on a machine with a GPU; a non-trivial
 * but sub-threshold diff is the expected healthy signal.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderComparisonFixtureKeys, type RenderComparisonFixtureKey } from "@kimera-by-aelivion/shared";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDir = path.join(repoRoot, "tmp", "scene-compositor-compare");

const diffThreshold = Number(process.env.PIXEL_DIFF_THRESHOLD ?? 0.16);
// Phase 4: every fixture carries a shape + captions, now rasterized to canvas in the scene path (vs the
// DOM text engine being retired). That canvas-vs-DOM text/shape delta lifts the floor for ALL fixtures,
// so the global bar is relaxed. The authoritative parity is scene == EXPORT (both use drawTextLayer);
// scene-vs-DOM is intentionally loose here. TUNE these to the observed values on the first GPU run.
// Tightened to the observed Phase-4 floor (~0.26%, captions+shape now canvas-rendered) with headroom.
const maxDiffRatio = Number(process.env.SCENE_MAX_DIFF_RATIO ?? 0.008);

// Per-fixture overrides: fixtures whose scene path runs a GPU Gaussian vs Chrome's CSS blur (kernel/
// edge/colorspace differ) get a looser bar — the residual is an edge band, not a fill difference.
// masked-blur is tightened from 2% to 1% now that the effect order is fixed (blur/glow BEFORE the
// mask → sharp ellipse, no halo). Pre-fix it sat at ~0.5% purely from the edge bleed; post-fix it
// should land near region-blur's ~0.3%. The 1% bar leaves headroom for the captions' 1× raster while
// still tripping if the blur-then-mask order regresses (which would re-introduce the corner leak).
const fixtureMaxDiff: Partial<Record<RenderComparisonFixtureKey, number>> = {
  blur: 0.02,
  "masked-blur": 0.01,
  // clip ∩ region blur: a clip mask AND a region blur on one layer (the compound case). Same GPU Gaussian +
  // matte-intersection as masked-blur/region-blur, so the bar matches them — the residual is the blur edge
  // band, not a fill difference. Trips if the clip∩region matte or the blur leaks (the user's "filter" repro).
  "clip-region-blur": 0.01,
  // 3D tilt: GPU composite quad vs CSS perspective — actual ~0.11% (just AA on the tilted edge), so a
  // 0.4% bar keeps headroom for cross-GPU AA variance while still tripping a real projection regression.
  "tilt-3d": 0.004,
  // Resolution-aware BOX raster: a scale-5 text, scene (box raster, crisp) vs DOM text — actual ~0.47%
  // (AA on the magnified glyph edges). 0.65% keeps cross-GPU headroom while still tripping a regression to
  // the comp-mode raster (which, magnified 5×, would be soft over a large area → several percent).
  "scaled-text": 0.0065,
  // Phase 4.1c text folds — scene now grades/masks/tilts TEXT in the GPU pass (was DOM fallback). Bars are
  // generous on the first run (AA on magnified/tilted glyph edges + scene LUT vs DOM SVG-filter grade);
  // tune toward the actuals after the first GPU run. A real regression (ungraded / unmasked / flat text)
  // diffs the whole glyph region → several percent, well past these.
  "graded-text": 0.01,
  "masked-text": 0.0085,
  // Region grade on TEXT (effect mask → expandLayerEffectRegions duplicate): scene vs DOM, both expand the
  // region the same way, so this sits near the graded/masked-text band. A regression (region ignored → whole
  // text graded, or not at all) diffs the whole glyph region → several percent.
  // 2026-07-03 recalibration 1.0% → 1.25%: actual drifted to ~1.11% — diff mass verified to be
  // region-SEAM + glyph-edge AA flavor only (scene/dom captures visually equivalent), and the drift
  // is independent of that day's decoder/image/sourceVersion work (A/B'd against a revert).
  "region-text": 0.0125,
  "tilted-text": 0.0085,
  // Phase 4.2 transition fold: scene mixes the junction in-canvas with the SAME assembled transition
  // shaders as the DOM overlay's `TransitionCompositor` (SceneCompositor.drawTransition, nest pre-compose),
  // so scene-vs-DOM should be near the ~0.26% baseline (the gate proves the mix lands at
  // the right z-slot with no offset + the DOM overlay is suppressed). A regression — missing/double mix or
  // wrong placement — diffs the whole frame, well past this.
  "transition": 0.006
};

const fixtureKeys: RenderComparisonFixtureKey[] = (() => {
  const raw = process.env.PIXEL_FIXTURES;
  if (!raw) {
    // `content-transform` and `plugin-shader` are scene/Remotion-only capabilities with no legacy DOM
    // preview equivalent (the DOM renderer has no fragment-shader pass at all, so a scene-vs-DOM diff
    // would just measure "inverted vs not-inverted" — not a meaningful parity check). Both are covered by
    // render:compare:pixels (preview vs Remotion) instead.
    return renderComparisonFixtureKeys.filter((key) => key !== "content-transform" && key !== "plugin-shader");
  }
  const requested = raw.split(",").map((v) => v.trim()).filter(Boolean);
  const valid = requested.filter((v): v is RenderComparisonFixtureKey =>
    renderComparisonFixtureKeys.includes(v as RenderComparisonFixtureKey)
  );
  if (!valid.length) throw new Error(`PIXEL_FIXTURES had no known fixtures. Known: ${renderComparisonFixtureKeys.join(", ")}`);
  return valid;
})();

// REGION_PASSES=1 runs the SCENE side with the region-effect pass model on (`&regionPasses=1`) while the
// DOM reference keeps its clone stacking — gating the pass model against the same oracle as the clone model.
const regionPasses = process.env.REGION_PASSES === "1" || process.env.REGION_PASSES === "true";
// SINGLE_CTX_PREVIEW=1 runs the SCENE side with the GPU-first single-context preview on
// (`&singleCtxPreview=1`) — media grades in-context on the SceneCompositor's own WebGL2 context instead of
// per-clip canvases. Gated against the SAME DOM oracle, so it must hold every fixture's threshold with ZERO
// changes (the flip acceptance gate). `&rendererMode=webgl` (already in `fixture`) makes media use the
// unified WebglMediaLayer producer that feeds the sink.
const singleCtxPreview = process.env.SINGLE_CTX_PREVIEW === "1" || process.env.SINGLE_CTX_PREVIEW === "true";
const sceneFlags = `${regionPasses ? "&regionPasses=1" : ""}${singleCtxPreview ? "&singleCtxPreview=1" : ""}`;

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  console.log(`Scene compositor parity: comparing compositor=scene vs compositor=dom${regionPasses ? " (region PASS model on)" : ""}${singleCtxPreview ? " (single-ctx preview on)" : ""}`);
  console.log(`Fixtures: ${fixtureKeys.join(", ")}`);

  const port = await getFreePort();
  const vite = startWebServer(port);
  const failures: string[] = [];
  try {
    const baseUrl = `http://127.0.0.1:${port}/editor/__preview-fixture`;
    await waitForServer(baseUrl);
    for (const key of fixtureKeys) {
      const fixture = `fixture=${encodeURIComponent(key)}&rendererMode=webgl`;
      const domPath = path.join(artifactDir, `dom-${key}.png`);
      const scenePath = path.join(artifactDir, `scene-${key}.png`);
      const diffPath = path.join(artifactDir, `diff-${key}.png`);
      if (key === "overlap-region-effects") {
        // Always the 3-way check (both flag states pinned explicitly in the URLs), so this fixture is
        // immune to the shipped default of the pass model.
        // The pass model INTENTIONALLY diverges from the DOM clone-stack here (effects COMBINE in the
        // overlap instead of top-wins), so a DOM comparison would assert against the model this fixture
        // replaces. Instead: (a) scene(off) must still match DOM (clone-model parity untouched), and
        // (b) scene(on) must DIFFER from scene(off) beyond a floor — proof the combine actually engaged
        // (a silently dropped pass would make them identical).
        const sceneOffPath = path.join(artifactDir, `scene-off-${key}.png`);
        const scPreview = singleCtxPreview ? "&singleCtxPreview=1" : "";
        await capturePreviewFrame(`${baseUrl}?${fixture}&compositor=dom`, domPath);
        await capturePreviewFrame(`${baseUrl}?${fixture}&compositor=scene&regionPasses=0${scPreview}`, sceneOffPath);
        await capturePreviewFrame(`${baseUrl}?${fixture}&compositor=scene&regionPasses=1${scPreview}`, scenePath);
        const offParity = comparePngs(domPath, sceneOffPath, diffPath);
        const limit = fixtureMaxDiff[key] ?? maxDiffRatio;
        // STRICT pixelmatch threshold for the combine delta: the standard perceptual threshold is tuned to
        // absorb DOM-vs-GPU rendering noise, which also absorbs a moderate grade shift (blur of graded vs
        // ungraded content) — the exact signal this check exists to detect.
        const combine = comparePngs(sceneOffPath, scenePath, path.join(artifactDir, `combine-${key}.png`), 0.02);
        const combineFloor = 0.02; // the graded-vs-ungraded overlap region is ~17% of the frame
        console.log(
          `[${key}] clone-parity ${(offParity.diffRatio * 100).toFixed(3)}% (limit ${(limit * 100).toFixed(2)}%), ` +
            `combine-delta ${(combine.diffRatio * 100).toFixed(3)}% (floor ${(combineFloor * 100).toFixed(2)}%)`
        );
        if (offParity.diffRatio > limit) failures.push(`${key}: clone-parity ${(offParity.diffRatio * 100).toFixed(3)}% > ${(limit * 100).toFixed(3)}%`);
        if (combine.diffRatio < combineFloor) failures.push(`${key}: combine-delta ${(combine.diffRatio * 100).toFixed(3)}% < floor — pass model did not change the overlap`);
        continue;
      }
      await capturePreviewFrame(`${baseUrl}?${fixture}&compositor=dom`, domPath);
      await capturePreviewFrame(`${baseUrl}?${fixture}&compositor=scene${sceneFlags}`, scenePath);
      const summary = comparePngs(domPath, scenePath, diffPath);
      const limit = fixtureMaxDiff[key] ?? maxDiffRatio;
      const pct = (summary.diffRatio * 100).toFixed(3);
      console.log(`[${key}] diff ${pct}% (limit ${(limit * 100).toFixed(2)}%) (${summary.diffPixels}/${summary.totalPixels}) → ${diffPath}`);
      if (summary.diffRatio > limit) failures.push(`${key}: ${pct}% > ${(limit * 100).toFixed(3)}%`);
    }
  } finally {
    await stopProcess(vite);
  }

  if (failures.length) {
    throw new Error(`Scene compositor parity failed for ${failures.length} fixture(s):\n  ${failures.join("\n  ")}`);
  }
  console.log(`Scene compositor parity passed for all ${fixtureKeys.length} fixture(s).`);
}

function startWebServer(port: number) {
  // shell:true so Windows resolves `pnpm` → `pnpm.cmd` (bare spawn is ENOENT; `.cmd` is EINVAL
  // without a shell). Args are static, so shell:true is safe here.
  const child = spawn(
    "pnpm",
    ["--dir", path.join(repoRoot, "apps/web"), "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, env: { ...process.env, BROWSER: "none" }, stdio: ["ignore", "pipe", "pipe"], shell: true }
  );
  child.stdout.on("data", (data) => process.stdout.write(`[web] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[web] ${data}`));
  return child;
}

async function capturePreviewFrame(url: string, outputPath: string) {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1200, height: 2100 } });
    // Forward the browser console + uncaught errors so GL/GLSL failures in the scene path are visible
    // (e.g. a shader compile error or a failed GL call that would otherwise just leave a blank canvas).
    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning") process.stdout.write(`[page:${type}] ${msg.text()}\n`);
    });
    page.on("pageerror", (err) => process.stdout.write(`[page:exception] ${err.message}\n`));
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
    // Give the scene compositor's rAF a couple frames to paint its first result.
    await page.waitForTimeout(250);
    await page.locator(".preview-composition-space").screenshot({
      animations: "disabled",
      caret: "hide",
      omitBackground: false,
      path: outputPath,
    });
  } finally {
    await browser.close();
  }
}

function comparePngs(aPath: string, bPath: string, diffPath: string, threshold: number = diffThreshold) {
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  assert.equal(a.width, b.width, "DOM and scene captures must match width.");
  assert.equal(a.height, b.height, "DOM and scene captures must match height.");
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold });
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
