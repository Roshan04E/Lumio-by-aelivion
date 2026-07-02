/**
 * Tests the resolution-aware BOX raster (Phase 4.1): does scaled scene text rasterize at ~the displayed
 * resolution (crisp like the export) WITHOUT re-rastering every frame?
 *
 * Imports the real SceneTextRasterizer and checks two things:
 *  1. CONTROLLED re-raster — sweep a 40→1 scale animation in box mode; the rasterizer bumps
 *     `versionOf(layerId)` on each ACTUAL re-raster. Buckets (powers of two) mean ≈ log2(40) re-rasters
 *     across the whole sweep, NOT 120 (one per frame). A per-frame count would be the flicker/perf bug.
 *  2. RESOLUTION-AWARE — a static scale-8 text rasterizes into a canvas ≈ 8× the pixels of the same text
 *     at scale 1, while the composite element box (`boxHalfW`, comp px) stays the SAME (the quad applies
 *     transform.scale separately). Same logical box, 8× the texels = crisp when magnified.
 *
 * Run: pnpm --filter @lumio-by-aelivion/worker exec tsx src/raster-resolution-probe.ts   (dev server must be up)
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";

const baseLayer = {
  id: "txt", trackId: "t", type: "text", name: "Text", text: "HI",
  fontFamily: "Arial", fontSize: 110, textAlign: "center", color: "#ffffff",
  startSeconds: 0, durationSeconds: 5,
  transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
  effects: [], keyframes: [],
};

const animated = {
  ...baseLayer,
  animations: [
    { id: "k1", target: { scope: "layer", property: "transform.scale" }, timeSeconds: 0, value: 40, interpolation: "linear" },
    { id: "k2", target: { scope: "layer", property: "transform.scale" }, timeSeconds: 2, value: 1, interpolation: "linear" },
  ],
};

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage();
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const result = await page.evaluate(async ({ animated, baseLayer }) => {
    const path = "/src/components/scene-text-raster.ts";
    const mod = await import(/* @vite-ignore */ path);
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const settle = async (r: { versionOf: (id: string) => number | undefined }, id: string) => {
      for (let i = 0; i < 60 && r.versionOf(id) === undefined; i++) await sleep(20);
    };

    // 1. Controlled re-raster across a 40→1 scale sweep (box mode = 5th arg true).
    const r = new mod.SceneTextRasterizer(() => {});
    r.get(animated, 0, 1080, 1920, true);
    await settle(r, "txt");
    const vStart = r.versionOf("txt");
    let nullReturns = 0;
    for (let t = 0; t <= 2.0001; t += 1 / 60) {
      if (!r.get(animated, t, 1080, 1920, true)) nullReturns++;
      await sleep(2);
    }
    await sleep(200);
    const vEnd = r.versionOf("txt");

    // 2. Resolution-awareness: static scale 1 vs scale 8 (separate rasterizers / ids).
    const measure = async (id: string, scale: number) => {
      const ri = new mod.SceneTextRasterizer(() => {});
      const layer = { ...baseLayer, id, transform: { ...baseLayer.transform, scale } };
      ri.get(layer, 0, 1080, 1920, true);
      await settle(ri, id);
      const out = ri.get(layer, 0, 1080, 1920, true);
      return { w: out?.canvas?.width ?? 0, h: out?.canvas?.height ?? 0, boxHalfW: out?.boxHalfW ?? 0 };
    };
    const s1 = await measure("s1", 1);
    const s8 = await measure("s8", 8);

    return { vStart, vEnd, nullReturns, sweepFrames: 120, s1, s8 };
  }, { animated, baseLayer });

  const reRasters = (result.vEnd ?? 0) - (result.vStart ?? 0);
  const widthRatio = result.s1.w ? result.s8.w / result.s1.w : 0;
  const boxDelta = Math.abs(result.s1.boxHalfW - result.s8.boxHalfW);

  console.log(`[raster res] reRasters over 40→1 sweep = ${reRasters} (of ${result.sweepFrames} frames; nullReturns=${result.nullReturns})`);
  console.log(`[raster res] scale1 canvas=${result.s1.w}x${result.s1.h} boxHalfW=${result.s1.boxHalfW.toFixed(1)}`);
  console.log(`[raster res] scale8 canvas=${result.s8.w}x${result.s8.h} boxHalfW=${result.s8.boxHalfW.toFixed(1)}`);
  console.log(`[raster res] widthRatio(scale8/scale1)=${widthRatio.toFixed(2)} (expect ≈8)  boxHalfW delta=${boxDelta.toFixed(2)}px (expect ≈0)`);

  const controlled = reRasters >= 1 && reRasters <= 15;
  const resolutionAware = widthRatio > 6 && widthRatio < 10;
  const boxStable = boxDelta < 2;
  const pass = controlled && resolutionAware && boxStable;
  console.log(`[raster res] ${pass ? "PASS ✅" : "FAIL ❌"} — controlled=${controlled} resolutionAware=${resolutionAware} boxStable=${boxStable}`);

  await browser.close();
  if (!pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
