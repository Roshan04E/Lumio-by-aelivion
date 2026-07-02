/**
 * Verifies the scene-mode playback flicker hypothesis: is it main-thread stutter that scales with the
 * preview-quality commit rate (P=90ms / B=40ms / Q=16ms)?
 *
 * Drives the real editor in `?compositor=scene`, plays, and for each quality (P/B/Q) samples
 * requestAnimationFrame intervals for ~3s — reporting how many frames overran (>20ms / >33ms), plus
 * p95/max. If Q has materially more long frames than P, the stutter-vs-quality hypothesis holds.
 *
 * Run: pnpm --filter @lumio-by-aelivion/worker exec tsx src/scene-jank-probe.ts   (dev server must be up)
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";

async function reachEditor(page: Page) {
  await page.goto(`${BASE}/create`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const useTemplate = page.getByRole("button", { name: /use template/i }).first();
  if (await useTemplate.count().catch(() => 0)) {
    await useTemplate.click().catch(() => undefined);
    await page.waitForURL(/\/editor\//, { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
  }
}

async function sampleJank(page: Page, ms: number) {
  return page.evaluate(async (durationMs) => {
    const deltas: number[] = [];
    let last = performance.now();
    const start = last;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = performance.now();
        deltas.push(now - last);
        last = now;
        if (now - start < durationMs) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    deltas.sort((a, b) => a - b);
    const over20 = deltas.filter((d) => d > 20).length;
    const over33 = deltas.filter((d) => d > 33).length;
    const p95 = deltas[Math.floor(deltas.length * 0.95)] ?? 0;
    const max = deltas[deltas.length - 1] ?? 0;
    const mean = deltas.reduce((s, d) => s + d, 0) / Math.max(1, deltas.length);
    return { frames: deltas.length, over20, over33, p95: Math.round(p95), max: Math.round(max), mean: Math.round(mean) };
  }, ms);
}

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  // tsx/esbuild keepNames injects a `__name` helper into evaluated functions; shim it (string init = no esbuild).
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("lumio.compositor", "scene"));
  await page.waitForTimeout(500);
  await reachEditor(page);

  const sceneCanvas = await page.locator(".preview-scene-canvas").count().catch(() => 0);
  console.log(`scene canvas present: ${Boolean(sceneCanvas)} (compositor=scene active)`);

  await page.getByRole("button", { name: /play/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(800);

  for (const q of ["P", "B", "Q"] as const) {
    await page.locator(".preview-quality-control button", { hasText: new RegExp(`^${q}$`) }).first().click().catch(() => undefined);
    await page.waitForTimeout(700); // settle
    const j = await sampleJank(page, 3000);
    console.log(
      `[${q}] frames=${j.frames} over20ms=${j.over20} over33ms=${j.over33} p95=${j.p95}ms max=${j.max}ms mean=${j.mean}ms`
    );
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
