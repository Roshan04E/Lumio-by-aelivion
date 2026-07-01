/**
 * Method 3 Phase 6.3 gate: local SceneCompositor export vs Remotion SceneStage.
 *
 * This compares the browser local-export compositor (`SceneFrameCompositor`) against the default Remotion
 * whole-frame compositor (SceneStage).
 *
 * It deliberately keeps `REMOTION_COMPOSITOR=scene` set for its own renders so the gate remains explicit even
 * though SceneStage is now the default.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderManifest } from "@reelforge/render-templates";
import {
  createRenderComparisonFixture,
  renderComparisonFrameSeconds,
  type RenderComparisonFixtureKey,
  type TimelineComposition
} from "@reelforge/shared";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { renderManifestStill } from "./remotion-renderer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDir = path.join(repoRoot, "tmp", "remotion-scene-compare");
const summaryPath = path.join(artifactDir, "summary.json");

const supportedFixtures: RenderComparisonFixtureKey[] = [
  "plain-image",
  "brightness-contrast",
  "color-curves",
  "object-fit-cover",
  "object-fit-contain",
  "content-transform",
  "person-matte",
  "clip-region-blur",
  "media-opacity",
  "transition",
  "graded-text",
  "masked-text",
  "region-text",
  "tilted-text",
  "scaled-text"
];

const unsupportedGaps: string[] = [];

const diffThreshold = Number(process.env.PIXEL_DIFF_THRESHOLD ?? 0.16);
const maxDiffRatio = Number(process.env.CLOUD_SCENE_MAX_DIFF_RATIO ?? 0.02);

interface SourceDef {
  url: string;
  kind: "video" | "image";
}

interface LocalRenderInput {
  fixture: RenderComparisonFixtureKey;
  composition: TimelineComposition;
  urlMap: Record<string, SourceDef>;
  timeSeconds: number;
}

interface FixtureResult {
  fixture: RenderComparisonFixtureKey;
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  localFramePath: string;
  remotionFramePath: string;
  diffFramePath: string;
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  console.log("Cloud scene parity: local SceneFrameCompositor export vs Remotion SceneStage");
  console.log(`Fixtures: ${supportedFixtures.join(", ")}`);
  console.log(`Unsupported gaps skipped: ${unsupportedGaps.join("; ")}`);

  const previousCompositor = process.env.REMOTION_COMPOSITOR;
  process.env.REMOTION_COMPOSITOR = "scene";

  const remotionStills = new Map<RenderComparisonFixtureKey, string>();
  const localInputs: LocalRenderInput[] = [];
  try {
    for (const key of supportedFixtures) {
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
      const remotionFramePath = path.join(artifactDir, `remotion-scene-${key}.png`);
      await renderManifestStill({ manifest, frame, outputLocation: remotionFramePath, rendererMode: "webgl" });
      remotionStills.set(key, remotionFramePath);
      localInputs.push({
        fixture: key,
        composition: fixture.graph.composition,
        urlMap: Object.fromEntries(
          fixture.assets.map((asset) => [
            asset.id,
            { url: asset.fileUrl, kind: asset.fileType.startsWith("video/") ? "video" : "image" } satisfies SourceDef
          ])
        ),
        timeSeconds: renderComparisonFrameSeconds
      });
    }
  } finally {
    if (previousCompositor == null) delete process.env.REMOTION_COMPOSITOR;
    else process.env.REMOTION_COMPOSITOR = previousCompositor;
  }

  const port = await getFreePort();
  const vite = startWebServer(port);
  const localStills = new Map<RenderComparisonFixtureKey, string>();
  try {
    const baseUrl = `http://127.0.0.1:${port}/`;
    await waitForServer(baseUrl);
    for (const input of localInputs) {
      const outputPath = path.join(artifactDir, `local-scene-${input.fixture}.png`);
      await renderLocalSceneFrame(baseUrl, input, outputPath);
      localStills.set(input.fixture, outputPath);
    }
  } finally {
    await stopProcess(vite);
  }

  const results: FixtureResult[] = [];
  const failures: string[] = [];
  for (const key of supportedFixtures) {
    const localFramePath = localStills.get(key)!;
    const remotionFramePath = remotionStills.get(key)!;
    const diffFramePath = path.join(artifactDir, `diff-${key}.png`);
    const summary = comparePngs(localFramePath, remotionFramePath, diffFramePath);
    const result = { fixture: key, localFramePath, remotionFramePath, diffFramePath, ...summary };
    results.push(result);
    const pct = (summary.diffRatio * 100).toFixed(3);
    console.log(`[${key}] diff ${pct}% (${summary.diffPixels}/${summary.totalPixels}) -> ${diffFramePath}`);
    if (summary.diffRatio > maxDiffRatio) {
      failures.push(`${key}: ${pct}% > ${(maxDiffRatio * 100).toFixed(3)}%`);
    }
  }

  const worst = results.reduce((max, result) => (result.diffRatio > max.diffRatio ? result : max), results[0]!);
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify({ maxDiffRatio, threshold: diffThreshold, unsupportedGaps, worst, results }, null, 2)}\n`
  );

  console.log(`Worst diff: ${worst.fixture} ${(worst.diffRatio * 100).toFixed(3)}%`);
  if (failures.length) {
    throw new Error(`Cloud scene parity failed for ${failures.length} fixture(s):\n  ${failures.join("\n  ")}`);
  }
  console.log(`Cloud scene parity passed for all ${results.length} fixture(s).`);
}

async function renderLocalSceneFrame(baseUrl: string, input: LocalRenderInput, outputPath: string) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1200, height: 2100 } });
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if ((type === "error" || type === "warning") && !text.includes("Failed to load resource")) {
        process.stdout.write(`[local:${type}] ${text}\n`);
      }
    });
    page.on("pageerror", (err) => process.stdout.write(`[local:exception] ${err.message}\n`));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const payload = {
      ...input,
      sharedModule: `/@fs/${path.join(repoRoot, "packages/shared/src/index.ts").replace(/\\/g, "/")}`,
      compositorModule: "/src/export/scene-frame-compositor.ts",
      decoderModule: "/src/export/source-decoder.ts"
    };
    await page.evaluate(`window.__LOCAL_SCENE_COMPARE_INPUT__ = ${JSON.stringify(payload).replace(/</g, "\\u003c")}`);
    const dataUrl = await page.evaluate(`(async () => {
      const payload = window.__LOCAL_SCENE_COMPARE_INPUT__;
      const [{ expandEffectRegionMasks }, { SceneFrameCompositor }, { createFrameProvider, clipSourceKey }] = await Promise.all([
        import(/* @vite-ignore */ payload.sharedModule),
        import(/* @vite-ignore */ payload.compositorModule),
        import(/* @vite-ignore */ payload.decoderModule)
      ]);

      const composition = expandEffectRegionMasks(payload.composition);
      const providers = new Map();
      const mediaSourceKey = (layer) => {
        if ((layer.type !== "video" && layer.type !== "image") || !layer.assetId) return null;
        return layer.type === "video" ? clipSourceKey(layer.id, layer.assetId) : layer.assetId;
      };
      const createImageElementProvider = async (url) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        await new Promise((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("local scene image decode failed"));
          image.src = url;
        });
        return {
          get width() { return image.naturalWidth; },
          get height() { return image.naturalHeight; },
          async getFrame() { return image; },
          dispose() { image.removeAttribute("src"); }
        };
      };
      for (const track of composition.tracks) {
        for (const layer of track.layers) {
          const key = mediaSourceKey(layer);
          if (key && layer.assetId) {
            const source = payload.urlMap[layer.assetId];
            if (source && !providers.has(key)) {
              providers.set(key, source.kind === "image" ? await createImageElementProvider(source.url) : await createFrameProvider(source.url, source.kind));
            }
          }
          if ((layer.type === "video" || layer.type === "image") && layer.matte?.uri) {
            const matteKey = \`matte:\${layer.id}\`;
            if (!providers.has(matteKey)) {
              const kind = layer.type === "video" ? "video" : "image";
              providers.set(matteKey, kind === "image" ? await createImageElementProvider(layer.matte.uri) : await createFrameProvider(layer.matte.uri, kind));
            }
          }
        }
      }

      const canvas = new OffscreenCanvas(composition.width, composition.height);
      const compositor = new SceneFrameCompositor(composition, canvas, (id) => providers.get(id));
      try {
        await compositor.renderFrame(payload.timeSeconds);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("local scene PNG encode failed"));
          reader.readAsDataURL(blob);
        });
      } finally {
        compositor.dispose();
        for (const provider of providers.values()) provider.dispose();
      }
    })()`);
    const base64 = (dataUrl as string).replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));
  } finally {
    await browser.close();
  }
}

function comparePngs(localPath: string, remotionPath: string, diffPath: string) {
  const local = PNG.sync.read(fs.readFileSync(localPath));
  const remotion = PNG.sync.read(fs.readFileSync(remotionPath));
  assert.equal(local.width, remotion.width, "Local scene and Remotion scene widths must match.");
  assert.equal(local.height, remotion.height, "Local scene and Remotion scene heights must match.");

  const diff = new PNG({ width: local.width, height: local.height });
  const diffPixels = pixelmatch(local.data, remotion.data, diff.data, local.width, local.height, {
    threshold: diffThreshold
  });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  const totalPixels = local.width * local.height;
  return { diffPixels, totalPixels, diffRatio: diffPixels / totalPixels };
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
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
