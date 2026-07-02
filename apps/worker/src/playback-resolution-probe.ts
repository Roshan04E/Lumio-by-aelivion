/**
 * Verifies Full/Half/Quarter playback resolution (scene compositor). The scene canvas BACKING
 * (`canvas.width`) should render at `comp × resolutionScale` WHILE PLAYING (Quarter=0.25, Half=0.5,
 * Full=1) and snap to Full (= comp, the canvas's CSS width) when PAUSED — while the CSS display width
 * stays logical comp throughout (so the on-screen size never changes, only the render resolution).
 *
 * Drives the real editor in `?compositor=scene`, plays, switches the playback-resolution control, and
 * reads `.preview-scene-canvas` `.width` (backing) vs its CSS width (logical comp).
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @lumio-by-aelivion/worker exec tsx src/playback-resolution-probe.ts
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

/** backing px (canvas.width) and CSS px (logical comp) of the scene canvas. */
async function readCanvas(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector(".preview-scene-canvas") as HTMLCanvasElement | null;
    if (!el) return null;
    return { backing: el.width, css: parseFloat(el.style.width || "0") || el.getBoundingClientRect().width };
  });
}

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("lumio.compositor", "scene"));
  await page.waitForTimeout(400);
  await reachEditor(page);

  if (!(await page.locator(".preview-scene-canvas").count().catch(() => 0))) {
    console.log("[playback res] FAIL ❌ — no .preview-scene-canvas (scene mode not active)");
    await browser.close();
    process.exit(1);
  }

  const setLevel = async (title: string) => {
    await page.locator(`.preview-quality-control button[title="${title} playback resolution"]`).first().click().catch(() => undefined);
    await page.waitForTimeout(400);
  };
  const play = async () => { await page.getByRole("button", { name: /play/i }).first().click().catch(() => undefined); await page.waitForTimeout(700); };
  const pause = async () => { await page.getByRole("button", { name: /pause/i }).first().click().catch(() => undefined); await page.waitForTimeout(500); };

  const results: Array<{ label: string; ratio: number; expect: number; ok: boolean }> = [];
  const check = async (label: string, expect: number) => {
    const c = await readCanvas(page);
    const ratio = c && c.css > 0 ? c.backing / c.css : 0;
    const ok = Math.abs(ratio - expect) < 0.06;
    results.push({ label, ratio, expect, ok });
    console.log(`[playback res] ${label}: backing/css = ${ratio.toFixed(3)} (expect ${expect}) ${ok ? "✅" : "❌"}  (backing=${c?.backing} css=${c?.css})`);
  };

  await setLevel("Full"); await play(); await check("playing Full", 1);
  await setLevel("Quarter"); await page.waitForTimeout(500); await check("playing Quarter", 0.25);
  await setLevel("Half"); await page.waitForTimeout(500); await check("playing Half", 0.5);
  await pause(); await check("paused (any level → Full)", 1);

  await browser.close();
  const pass = results.every((r) => r.ok);
  console.log(`[playback res] ${pass ? "PASS ✅" : "FAIL ❌"}`);
  if (!pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
