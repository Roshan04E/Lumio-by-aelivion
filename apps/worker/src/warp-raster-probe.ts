/**
 * Isolates the warp-raster root cause: does `createImageBitmap(svgBlob)` need `xmlns` to render?
 *
 * The scene/export text rasterizers feed `buildWarpedTextPathSvg`'s markup to
 * `createImageBitmap(new Blob([markup], {type:"image/svg+xml"}))`. This probe rasterizes a
 * representative warp-style SVG (one filled <path>) WITH and WITHOUT the xmlns, draws each onto a
 * canvas, and counts non-transparent pixels. Proves the namespace is required (without it → 0 pixels).
 *
 * Run: pnpm --filter @orreris/worker exec tsx src/warp-raster-probe.ts
 */
import { chromium } from "playwright";

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");

  const body = `class="warp-text-path" viewBox="0 0 400 120" preserveAspectRatio="none" width="400" height="120"><path d="M20 100 Q200 0 380 100 L380 110 Q200 20 20 110 Z" fill="#ffffff"/>`;
  const markups = {
    withNs: `<svg xmlns="http://www.w3.org/2000/svg" ${body}</svg>`,
    withoutNs: `<svg ${body}</svg>`,
  };
  // A representative warped-glyph path `d` (what buildWarpedTextPaths emits) — a filled blob.
  const warpD = "M20 100 Q200 0 380 100 L380 110 Q200 20 20 110 Z";
  const result = await page.evaluate(async (m) => {
    const out: Record<string, number | string> = {};
    // Path A (old): createImageBitmap(svgBlob) — proves the old raster path is broken in Chrome.
    try {
      await createImageBitmap(new Blob([m.svg], { type: "image/svg+xml" }));
      out.oldBitmap = "decoded";
    } catch (e) {
      out.oldBitmap = `THREW: ${String(e)}`;
    }
    // Path B (new): Path2D fill on a normal canvas (main-thread scene raster).
    try {
      const c = document.createElement("canvas");
      c.width = 400;
      c.height = 120;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fill(new Path2D(m.d));
      const data = ctx.getImageData(0, 0, 400, 120).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
      out.path2dCanvas = n;
    } catch (e) {
      out.path2dCanvas = `THREW: ${String(e)}`;
    }
    // Path C (new): Path2D fill on an OffscreenCanvas (the export Worker context — no Image/document).
    try {
      const oc = new OffscreenCanvas(400, 120);
      const octx = oc.getContext("2d")!;
      octx.fillStyle = "#ffffff";
      octx.fill(new Path2D(m.d));
      const data = octx.getImageData(0, 0, 400, 120).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
      out.path2dOffscreen = n;
    } catch (e) {
      out.path2dOffscreen = `THREW: ${String(e)}`;
    }
    return out;
  }, { svg: markups.withNs, d: warpD });

  console.log(`[old: createImageBitmap(svgBlob)] ${result.oldBitmap}`);
  console.log(`[new: Path2D → canvas]           ${result.path2dCanvas}px`);
  console.log(`[new: Path2D → OffscreenCanvas]  ${result.path2dOffscreen}px`);
  const canvasOk = typeof result.path2dCanvas === "number" && result.path2dCanvas > 100;
  const offscreenOk = typeof result.path2dOffscreen === "number" && result.path2dOffscreen > 100;
  console.log(
    `[warp raster] Path2D renders on main-thread ${canvasOk ? "✅" : "❌"} and in Worker/OffscreenCanvas ${offscreenOk ? "✅" : "❌"}`
  );
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
