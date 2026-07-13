/**
 * Headless probe for the viewer fit-zoom feedback loop (editor stability).
 *
 * Drives the REAL running dev editor (localhost:5173), reaches an editor instance, clicks "Fit", and
 * samples the displayed viewer-zoom % over ~3s. A healthy fit CONVERGES (stable value); the bug is a
 * 2-cycle oscillation (e.g. 57↔100 / 74↔78). Reports min/max/spread + the sample sequence.
 *
 * Run: pnpm --filter @kimera-by-aelivion/worker exec tsx src/zoom-probe.ts   (dev server must be up)
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";
const DEMO = { email: "demo@aelivion.studio", password: "password123" };

async function tryLogin(page: Page) {
  const email = page.locator('input[type="email"]').first();
  if (await email.count().catch(() => 0)) {
    if (await email.isVisible().catch(() => false)) {
      await email.fill(DEMO.email);
      await page.locator('input[type="password"]').first().fill(DEMO.password);
      await page.getByRole("button", { name: /sign in|log ?in|continue/i }).first().click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }
  }
}

async function reachEditor(page: Page) {
  if (page.url().includes("/editor/")) return;
  // The /create page's "Use Template" spins up a (local-first) project and navigates to the editor.
  await page.goto(`${BASE}/create`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const useTemplate = page.getByRole("button", { name: /use template/i }).first();
  if ((await useTemplate.count().catch(() => 0)) && (await useTemplate.isVisible().catch(() => false))) {
    await useTemplate.click().catch(() => undefined);
    await page.waitForURL(/\/editor\//, { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
  }
}

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const [vw, vh] = (process.env.PROBE_VIEWPORT ?? "1600x900").split("x").map((n) => Number.parseInt(n, 10));
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage({ viewport: { width: vw || 1600, height: vh || 900 } });
  console.log(`viewport=${vw}x${vh}`);
  page.on("console", (m) => {
    if (m.type() === "error") process.stdout.write(`[page:error] ${m.text()}\n`);
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await tryLogin(page);
  await reachEditor(page);

  const zoomLabel = page.locator(".viewer-zoom-control small").first();
  const ready = await zoomLabel.count().catch(() => 0);
  console.log(`url=${page.url()}  zoomLabelFound=${Boolean(ready)}`);
  if (!ready) {
    await page.screenshot({ path: "tmp/zoom-probe-entry.png" }).catch(() => undefined);
    console.log("Could not find the editor zoom control. Saved tmp/zoom-probe-entry.png for inspection.");
    await browser.close();
    return;
  }

  const measure = () =>
    page.evaluate(() => {
      const comp = document.querySelector(".editor-viewer .preview-composition-space");
      const vp = document.querySelector(".editor-viewer .preview-viewport");
      const label = document.querySelector(".viewer-zoom-control small");
      const c = comp?.getBoundingClientRect();
      const v = vp?.getBoundingClientRect();
      return {
        pct: label ? Number.parseInt((label.textContent ?? "").replace(/[^0-9]/g, ""), 10) : Number.NaN,
        compW: c?.width ?? 0,
        compH: c?.height ?? 0,
        vpW: v?.width ?? 0,
        vpH: v?.height ?? 0,
      };
    });

  // FIT: sample stability + correctness (the comp must actually fill the viewer, not collapse to ~10%).
  await page.getByRole("button", { name: /^Fit$/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(400);
  const samples: { pct: number; compW: number; compH: number; vpW: number; vpH: number }[] = [];
  for (let i = 0; i < 20; i++) {
    samples.push(await measure());
    await page.waitForTimeout(100);
  }
  const pcts = samples.map((s) => s.pct).filter(Number.isFinite);
  const spread = Math.max(...pcts) - Math.min(...pcts);
  const last = samples[samples.length - 1]!;
  const PAD = 112; // .preview-viewport padding (56 each side)
  const fillRatio = Math.max(last.compW / Math.max(1, last.vpW - PAD), last.compH / Math.max(1, last.vpH - PAD));
  console.log(`[Fit] pct=${last.pct}% spread=${spread}  comp=${Math.round(last.compW)}x${Math.round(last.compH)}  viewport=${Math.round(last.vpW)}x${Math.round(last.vpH)}  fillRatio=${fillRatio.toFixed(2)}`);
  console.log(`[Fit] ${spread <= 1 ? "STABLE ✅" : "OSCILLATING ❌"} | ${fillRatio >= 0.85 && fillRatio <= 1.06 ? "FILLS VIEWER ✅" : "WRONG SIZE ❌ (should ≈1.0)"}`);

  // 100% preset: comp should render ~1:1 (rendered px ≈ comp pixels → much larger than Fit).
  await page.getByRole("button", { name: /^100$/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(400);
  const at100 = await measure();
  console.log(`[100%] pct=${at100.pct}%  comp=${Math.round(at100.compW)}x${Math.round(at100.compH)} (1:1 actual pixels; scrolls if > viewer)`);

  await page.screenshot({ path: "tmp/zoom-probe-fit.png" }).catch(() => undefined);
  // Capture a timeline track header (the Solo "S" / delete alignment).
  const trackControls = page.locator(".track-controls").first();
  if (await trackControls.count().catch(() => 0)) {
    await trackControls.screenshot({ path: "tmp/track-controls.png" }).catch(() => undefined);
    const box = await trackControls.boundingBox().catch(() => null);
    console.log(`[track-controls] box=${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "none"} → tmp/track-controls.png`);
  } else {
    console.log("[track-controls] not found");
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
