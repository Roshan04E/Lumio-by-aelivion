/**
 * DEBT-027 diagnostic. `flarex-frame-cache-field-probe.ts`'s media fixture found 1-2 of 6 positions
 * with no stable served time; the entry named the cause "decoder supply" but left the mechanism to a
 * future session, since `awaitReason`/`elementTime`/`wcBusy` (`WebglMediaLayer.tsx`) and
 * `window.__rfFramePresent`'s frame-disposition tally (presented/providerChanged/heldNotPresented/
 * nullFrame/threw — `WebglMediaLayer.tsx:178`) are already published and readable without building
 * anything new.
 *
 * Reproduces the same media fixture (one asset-source Flarex MediaIn over real footage) and scrubs the
 * SAME 6 ruler fractions the field probe calibrated to, as two full sweeps (mirroring its B-then-C
 * oracle check), dumping `__rfSourceMap` and `__rfFramePresent` after every settle.
 *
 * Found: `heldNotPresented` climbs enormously (measured 62 -> 457 across ~8s of scrubbing) while
 * `presented` barely advances (6 -> 23) — the source spends nearly all its cycles in the paused
 * catch-up-hold branch (`requestWcFrame`'s `lag > WC_HOLD_LAG_S` path), never converging long enough to
 * count as genuinely stalled. See DEBT-027 in the tracker for the full mechanism writeup and why a fix
 * was not attempted this session.
 *
 * Run (dev server up, real footage in the seeded clip path):
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-debt027-source-map-probe.ts
 */
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { addAssetSourceMediaIn, awaitWebCodecsEngaged, defaultClipPath, reachEditor } from "./browser/editor-session.js";

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";

async function rulerGeometry(page: Page): Promise<{ y: number; left: number; width: number } | null> {
  return page.evaluate(() => {
    const ruler = document.querySelector(".timeline-ruler");
    if (!(ruler instanceof HTMLElement)) return null;
    const r = ruler.getBoundingClientRect();
    if (r.width < 50) return null;
    return { y: r.top + r.height / 2, left: r.left, width: r.width };
  });
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex-debt027-source-map-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());

  const projectUrl = await reachEditor(page, { clipPath: defaultClipPath(20), flags: "wcDecode=1&frameCache=1" });
  console.log(`project: ${projectUrl}`);
  await awaitWebCodecsEngaged(page);
  const seeded = await addAssetSourceMediaIn(page);
  console.log(`flarex comp: ${seeded.ok}`);
  await page.goto(`${projectUrl}&frameCache=1`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(10_000);

  const geometry = await rulerGeometry(page);
  if (!geometry) throw new Error("no ruler geometry");

  // The real field probe's own calibrated fractions from a prior run, visited as TWO FULL SWEEPS in
  // order (mirrors B-then-C) — visiting all 6 in sequence, twice, so `currentTime` genuinely changes
  // away and back between repeat visits to one position, unlike clicking the same spot twice in a row.
  const FRACTIONS = [
    { label: "0.110 (t=2.2)", frac: 0.11 },
    { label: "0.248 (t=5.0)", frac: 0.248 },
    { label: "0.387 (t=7.8)", frac: 0.387 },
    { label: "0.526 (t=10.6)", frac: 0.526 },
    { label: "0.665 (t=13.3)", frac: 0.665 },
    { label: "0.804 (t=16.1)", frac: 0.804 },
  ];

  await page.evaluate((v: boolean) => {
    (window as unknown as { __rfFrameCacheBypass?: boolean }).__rfFrameCacheBypass = v;
  }, true);

  for (let sweep = 0; sweep < 2; sweep++) {
    console.log(`\n########## SWEEP ${sweep} ##########`);
    for (const { label, frac } of FRACTIONS) {
      await page.mouse.click(geometry.left + geometry.width * frac, geometry.y);
      await page.waitForTimeout(900);
      console.log(`\n=== stop ${label} ===`);
      const dump = await page.evaluate(() => {
        const w = window as unknown as {
          __rfSourceMap?: Record<string, unknown>;
          __rfClock?: { committed?: number };
          __rfFrameCache?: { served?: unknown };
          __rfFlarexProxy?: unknown;
          __rfFramePresent?: Record<string, number>;
        };
        return {
          clock: w.__rfClock?.committed ?? null,
          sourceMap: w.__rfSourceMap ?? {},
          served: w.__rfFrameCache?.served ?? null,
          proxy: w.__rfFlarexProxy ?? null,
          present: w.__rfFramePresent ?? null,
        };
      });
      console.log(`  sweep ${sweep}: clock=${dump.clock}`);
      for (const [id, entry] of Object.entries(dump.sourceMap)) {
        console.log(`    ${id}: ${JSON.stringify(entry)}`);
      }
      if (dump.served) console.log(`    served: ${JSON.stringify(dump.served)}`);
      if (dump.proxy) console.log(`    __rfFlarexProxy: ${JSON.stringify(dump.proxy)}`);
      console.log(`    __rfFramePresent: ${JSON.stringify(dump.present)}`);
    }
  }

  await browser.close();
}

void main();
