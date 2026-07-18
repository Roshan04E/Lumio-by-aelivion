/**
 * Directly tests Phase 4.1b: does a TRANSFORM (scale) animation re-rasterize the text every frame, or
 * reuse one cached raster? Imports the real SceneTextRasterizer, builds a text layer with a scale
 * keyframe (40→1), and sweeps `get(layer, t)` across the animation like playback would. The rasterizer
 * bumps `versionOf(layerId)` on each ACTUAL re-raster — so a flat version across the sweep = reuse
 * (4.1b working, no flicker source); a growing version = re-raster per frame (the flicker).
 *
 * Run: pnpm --filter @orreris/worker exec tsx src/raster-reuse-probe.ts   (dev server must be up)
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";

const layer = {
  id: "txt", trackId: "t", type: "text", name: "Text", text: "Text",
  startSeconds: 0, durationSeconds: 5,
  transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
  animations: [
    { id: "k1", target: { scope: "layer", property: "transform.scale" }, timeSeconds: 0, value: 40, interpolation: "linear" },
    { id: "k2", target: { scope: "layer", property: "transform.scale" }, timeSeconds: 2, value: 1, interpolation: "linear" },
  ],
  effects: [], keyframes: [],
};

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage();
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const result = await page.evaluate(async (lyr) => {
    const path = "/src/components/scene-text-raster.ts";
    const mod = await import(/* @vite-ignore */ path);
    let readyCount = 0;
    const r = new mod.SceneTextRasterizer(() => { readyCount++; });
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

    // Kick off the first raster and wait for it to land.
    r.get(lyr, 0, 1080, 1920);
    for (let i = 0; i < 60 && r.versionOf("txt") === undefined; i++) await sleep(20);
    const vStart = r.versionOf("txt");

    // Sweep the scale animation like playback (40→1 over 2s, ~60fps).
    let nullReturns = 0;
    for (let t = 0; t <= 2.0001; t += 1 / 60) {
      const canvas = r.get(lyr, t, 1080, 1920);
      if (!canvas) nullReturns++;
      await sleep(2);
    }
    await sleep(200);
    const vEnd = r.versionOf("txt");
    return { vStart, vEnd, readyCount, nullReturns, sweepFrames: Math.round(2 * 60) };
  }, layer);

  console.log(`[raster reuse] versionStart=${result.vStart} versionEnd=${result.vEnd} reRasters=${(result.vEnd ?? 0) - (result.vStart ?? 0)}`);
  console.log(`[raster reuse] readyCallbacks=${result.readyCount} nullReturns=${result.nullReturns}/${result.sweepFrames}`);
  const reused = (result.vEnd ?? 0) - (result.vStart ?? 0) === 0;
  console.log(`[raster reuse] ${reused ? "REUSED ONE RASTER ✅ (4.1b works — flicker is NOT re-raster)" : "RE-RASTERS PER FRAME ❌ (4.1b bug — this is the flicker)"}`);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
