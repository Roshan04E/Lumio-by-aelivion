/**
 * DEBT-005 acceptance soak — may the settle-window backstop be retired?
 *
 * The register's condition: `settle-backstop-expired` and `settle-window-load-bearing` both read ZERO
 * across a real soak in steady state. S7.2 family 4 deleted `kernelFrames`, which made explicit frame
 * completion unconditional — the state this gate was protecting — WITHOUT this evidence ever being
 * collected. This run owes that debt.
 *
 * WHAT MAKES A ZERO MEANINGFUL. The settle window is consulted only while PAUSED; during playback the
 * transport owns the cadence and the classifier is not reached. A play-only soak would therefore report
 * zero having measured nothing. So the arms are paused-heavy: seek, pause, let sources arrive.
 *
 * VACUITY GUARD. Only `surplus` and `load-bearing` composites are recorded, so `converging` cannot
 * witness the classifier. `surplus` is the witness: it means the window kept compositing after the
 * picture settled — waste, and proof the code ran. A run with load-bearing 0 AND surplus 0 has not
 * shown the window is retirable; it has shown the window was never entered. That run is VOID.
 */
import { chromium, type Browser, type Page } from "playwright";
import { reachEditor } from "./browser/editor-session.js";

const SECONDS = Number(process.env.SOAK_SECONDS ?? 20);

async function census(page: Page) {
  return page.evaluate(() => {
    const w = globalThis as Record<string, any>;
    const k = w.__rfKernel;
    if (!k?.enabled) return { enabled: false, reasons: {} as Record<string, number>, total: 0 };
    const reasons: Record<string, number> = {};
    for (const ev of k.events("transition") as Array<Record<string, any>>) {
      const r = String(ev.reason ?? "?");
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
    return { enabled: true, reasons, total: Object.values(reasons).reduce((a, b) => a + b, 0) };
  });
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser: Browser = await chromium.launch(channel ? { channel } : {});
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await reachEditor(page, { settleMs: 8_000 });

  // PAUSED WORK. Every seek re-arms the window and every arrival after it is what `load-bearing`
  // exists to catch. Interleaved with short plays so the run is not one long idle.
  const ruler = page.locator(".timeline-ruler, .timeline-scrubber").first();
  const box = await ruler.boundingBox().catch(() => null);
  for (let i = 0; i < SECONDS; i += 1) {
    if (box) {
      const x = box.x + box.width * (0.1 + 0.8 * ((i % 8) / 8));
      await page.mouse.click(x, box.y + box.height / 2).catch(() => undefined);
    }
    await page.waitForTimeout(500);
    if (i % 5 === 4) {
      await page.keyboard.press("Space").catch(() => undefined);   // play
      await page.waitForTimeout(1_200);
      await page.keyboard.press("Space").catch(() => undefined);   // pause — back into the window
      await page.waitForTimeout(800);
    }
  }

  // STEADY STATE is the delta over a QUIET tail, not the whole run. The gesture phase above is churn
  // by construction — every seek re-arms the window — and a backstop firing mid-scrub says the picture
  // had not caught up with the user yet, which is the window doing its job rather than debt. The
  // register's condition is about steady state, so measure it there: stop touching anything, stay
  // paused, and count only what fires after.
  const before = await census(page);
  await page.waitForTimeout(15_000);
  const c = await census(page);
  const d = (k: string) => (c.reasons[k] ?? 0) - (before.reasons[k] ?? 0);
  console.log(`
GESTURE PHASE (churn, context only): ${JSON.stringify(before.reasons)}`);
  console.log(`QUIET TAIL 15s deltas: backstop ${d("settle-backstop-expired")} · load-bearing ${d("settle-window-load-bearing")} · surplus ${d("settle-window-surplus")} · held ${d("frame-held")}`);
  const backstop = c.reasons["settle-backstop-expired"] ?? 0;
  const loadBearing = c.reasons["settle-window-load-bearing"] ?? 0;
  const surplus = c.reasons["settle-window-surplus"] ?? 0;

  console.log(`\ndiagnostics enabled: ${c.enabled}`);
  console.log(`transition events: ${c.total}`);
  console.log(JSON.stringify(c.reasons, null, 1));
  console.log(`\nsettle-backstop-expired    ${backstop}`);
  console.log(`settle-window-load-bearing ${loadBearing}`);
  console.log(`settle-window-surplus      ${surplus}   (vacuity witness)`);

  if (!c.enabled) console.log("\nVOID: kernelDiagnostics is off — both counters live behind it.");
  else if (surplus === 0 && loadBearing === 0)
    console.log("\nVOID: the classifier was never reached; zero here is 'not measured', not 'clean'.");
  else if (backstop === 0 && loadBearing === 0)
    console.log("\nPASS: window entered and never load-bearing — DEBT-005's condition is met by this run.");
  else console.log("\nFAIL: the backstop is still doing work — it names a producer to fix, not a timer to keep.");

  await ctx.close();
  await browser.close();
}
main().then(() => setTimeout(() => process.exit(0), 3_000).unref()).catch((e) => { console.error(e); process.exit(1); });
