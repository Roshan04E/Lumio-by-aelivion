/**
 * MEASUREMENT ONLY — F1-F4, confirming the located mechanism before any fix is written.
 *
 * LOCATED MECHANISM (WebglMediaLayer.tsx): WC_BUSY_WEDGE_MS = 3000. A decode request in flight over
 * 3000ms is declared a "busy wedge" and, for a non-tolerateLag layer (an ordinary timeline clip, not a
 * Flarex virtual loader), triggers `wcFallbackRef.current()` — permanent demotion to `<video>`, per
 * DEBT-013 never re-admitted. The watchdog is meant to catch a HUNG decoder; the hypothesis is that a
 * legitimately slow seek (decoding forward from a distant keyframe on this clip's sparse 8.33s GOP,
 * per D3) is indistinguishable from a hang and gets the same permanent remedy.
 *
 * This script does not infer that from the earlier E1/E2 timing — it reads the mechanism's OWN
 * telemetry (`__rfWcHeals`, keyed by reason string) at the moment of demotion, and times the demoting
 * seek itself with the canvas-pixel instrument (not the mode-flag flip, which is what left a gap last
 * round).
 *
 *   F1. WHICH FALLBACK FIRED — snapshot `__rfWcHeals` before/after the demoting seek; report which key
 *       incremented. "busyWedge" confirms the site; anything else means the mechanism above is wrong.
 *   F2. THE ARITHMETIC — report the wall-clock time from the seek firing to the heal firing, and
 *       whether it crosses 3000ms. (`wcInFlightSinceMsRef` is a React ref, not on window, so this uses
 *       the seek click as a proxy for in-flight-start — close per the code, `wcInFlightSinceMsRef` is
 *       set essentially at request dispatch — and is reported as a proxy, not asserted as exact.)
 *   F3. THE DEMOTING SEEK'S OWN TIME-TO-PICTURE — the canvas-pixel instrument, on the SAME seek that
 *       trips the heal. This is the number comparable to the founder's "4-5 seconds", closing the gap
 *       the previous round left open.
 *   F4. KEYFRAME CORRELATION — from a fresh settled wc-hw state, one seek landing ~0.3s AFTER a
 *       preceding keyframe (minimal decode-forward), one landing ~0.3s BEFORE the next keyframe
 *       (near-maximal decode-forward within one GOP). Using D3's own measured table (median GOP
 *       8.333s, keyframe at 8.33s and 16.67s): near target 8.63s, far target 16.37s.
 *
 * PRE-REGISTERED: CONFIRMED (F1 reads busyWedge, F2 crosses 3000ms, F4 near survives / far demotes) /
 * WRONG SITE (F1 names something else — report and stop) / PARTIAL (report which links hold; do not
 * present a partial chain as complete).
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker rulerjump:wedgeconfirm
 */
import os from "node:os";
import { execSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { defaultClipPath, reachEditor } from "./browser/editor-session";

function reportMachineState(): void {
  const freeGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  const totalGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  let chromeCount = "?";
  let nodeCount = "?";
  try {
    const out = execSync("tasklist", { encoding: "utf8" });
    chromeCount = String((out.match(/chrome\.exe/gi) ?? []).length);
    nodeCount = String((out.match(/node\.exe/gi) ?? []).length);
  } catch {
    /* best effort */
  }
  console.log(`machine state: free ${freeGB}GB / ${totalGB}GB total, chrome.exe x${chromeCount}, node.exe x${nodeCount}`);
}

interface RoutingEntry { at: number; route: "element" | "pool"; }

async function readRouting(page: Page): Promise<Record<string, RoutingEntry[]>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfRouting ?? {}) }));
}
async function readWcModes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfWcMode ?? {}) }));
}
async function readWcHeals(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfWcHeals ?? {}) }));
}
async function nowBrowser(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

async function calibrateRuler(page: Page): Promise<{ rulerY: number; rulerLeft: number; rulerRight: number; pxPerSec: number } | null> {
  const geometry = await page.evaluate(() => {
    const ruler = document.querySelector(".timeline-ruler");
    if (!(ruler instanceof HTMLElement)) return null;
    const r = ruler.getBoundingClientRect();
    return { rulerY: r.top + r.height / 2, rulerLeft: r.left, rulerRight: r.right };
  });
  if (!geometry) return null;
  const clickAt = async (x: number): Promise<number | null> => {
    await page.mouse.click(x, geometry.rulerY);
    await page.waitForTimeout(200);
    return page.evaluate(() => (window as unknown as { __rfClock?: { committed: number } }).__rfClock?.committed ?? null);
  };
  const refX = geometry.rulerLeft + 40;
  const cutX = geometry.rulerLeft + 240;
  const t1 = await clickAt(refX);
  const t2 = await clickAt(cutX);
  if (t1 == null || t2 == null || t2 <= t1) return null;
  return { rulerY: geometry.rulerY, rulerLeft: geometry.rulerLeft, rulerRight: geometry.rulerRight, pxPerSec: (cutX - refX) / (t2 - t1) };
}
async function seekToSeconds(page: Page, cal: NonNullable<Awaited<ReturnType<typeof calibrateRuler>>>, seconds: number): Promise<void> {
  const targetX = cal.rulerLeft + 40 + seconds * cal.pxPerSec;
  const clamped = Math.min(cal.rulerRight - 4, Math.max(cal.rulerLeft + 4, targetX));
  await page.mouse.click(clamped, cal.rulerY);
}

async function installPixelProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __jumpProbe?: { hash: () => number | null } };
    if (w.__jumpProbe) return;
    const probe = document.createElement("canvas");
    probe.width = 24;
    probe.height = 24;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    const findCanvas = (): HTMLCanvasElement | null => {
      const list = document.querySelectorAll("canvas");
      let best: HTMLCanvasElement | null = null;
      for (const c of Array.from(list) as HTMLCanvasElement[]) {
        if (c === probe) continue;
        if (!best || c.width * c.height > best.width * best.height) best = c;
      }
      return best;
    };
    w.__jumpProbe = {
      hash(): number | null {
        const c = findCanvas();
        if (!c || !pctx || c.width === 0) return null;
        try {
          pctx.drawImage(c, 0, 0, 24, 24);
          const d = pctx.getImageData(0, 0, 24, 24).data;
          let h = 0;
          for (let i = 0; i < d.length; i += 4) {
            h = (h * 31 + d[i]!) | 0;
            h = (h * 31 + d[i + 1]!) | 0;
            h = (h * 31 + d[i + 2]!) | 0;
          }
          return h;
        } catch {
          return null;
        }
      },
    };
  });
}
async function pixelHash(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __jumpProbe: { hash: () => number | null } }).__jumpProbe.hash());
}

async function awaitSubjectPoolAttempt(page: Page, timeoutMs = 240_000): Promise<{ key: string; entryAtMs: number } | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const routing = await readRouting(page);
    for (const [key, entries] of Object.entries(routing)) {
      const hit = entries.find((e) => e.route === "pool");
      if (hit) return { key, entryAtMs: hit.at };
    }
    await page.waitForTimeout(150);
  }
  return null;
}

interface DemoteMeasurement {
  label: string;
  targetSeconds: number;
  subjectKey: string;
  modeBeforeSeek: string | undefined;
  healReason: string | null;
  msFromClickToHeal: number | null;
  crossedWedgeThreshold: boolean | null;
  msFromClickToPictureFirstChange: number | null;
  msFromClickToPictureSettle: number | null;
  pictureTimedOut: boolean;
  demoted: boolean;
  finalMode: string | undefined;
  voidReason: string | null;
}

const WC_BUSY_WEDGE_MS = 3000;

async function runOneSeekScenario(page: Page, projectUrl: string, label: string, targetSeconds: number): Promise<DemoteMeasurement> {
  console.log(`\n═══ ${label} (single seek to t=${targetSeconds}s from a fresh settled state) ═══`);
  await page.goto(projectUrl.split("?")[0] + "?wcDecode=1&kernelDiagnostics=1", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_500);
  await installPixelProbe(page);

  const subject = await awaitSubjectPoolAttempt(page);
  if (!subject) {
    return {
      label, targetSeconds, subjectKey: "", modeBeforeSeek: undefined, healReason: null, msFromClickToHeal: null,
      crossedWedgeThreshold: null, msFromClickToPictureFirstChange: null, msFromClickToPictureSettle: null,
      pictureTimedOut: false, demoted: false, finalMode: undefined, voidReason: "subject never attempted the pool within 240s",
    };
  }
  // Settle well past init (matches E2 — no init-window effect was found, but staying consistent avoids
  // reintroducing the variable this round is not testing).
  await page.waitForTimeout(10_000);
  const modeBeforeSeek = (await readWcModes(page))[subject.key];
  console.log(`  subject key: ${subject.key}  mode before seek: ${modeBeforeSeek ?? "(absent)"}`);
  if (!modeBeforeSeek || modeBeforeSeek === "element") {
    return {
      label, targetSeconds, subjectKey: subject.key, modeBeforeSeek, healReason: null, msFromClickToHeal: null,
      crossedWedgeThreshold: null, msFromClickToPictureFirstChange: null, msFromClickToPictureSettle: null,
      pictureTimedOut: false, demoted: false, finalMode: modeBeforeSeek,
      voidReason: "subject was on 'element' before the test seek (nothing to demote)",
    };
  }

  const cal = await calibrateRuler(page);
  if (!cal) {
    return {
      label, targetSeconds, subjectKey: subject.key, modeBeforeSeek, healReason: null, msFromClickToHeal: null,
      crossedWedgeThreshold: null, msFromClickToPictureFirstChange: null, msFromClickToPictureSettle: null,
      pictureTimedOut: false, demoted: false, finalMode: modeBeforeSeek, voidReason: "ruler calibration failed",
    };
  }

  // Pre-position near the start (t=2s, near the 0.00 keyframe) so the measured seek below is a REAL,
  // sizeable seek toward the target rather than a near-no-op.
  await seekToSeconds(page, cal, 2);
  await page.waitForTimeout(1_500);

  const healsBefore = await readWcHeals(page);
  const clickedAtMs = Date.now();

  const beforeHash = await pixelHash(page);
  await seekToSeconds(page, cal, targetSeconds);

  let healReason: string | null = null;
  let msFromClickToHeal: number | null = null;
  let firstChangeAt: number | null = null;
  let settleAt: number | null = null;
  let lastHash = beforeHash;
  let lastChangeAt = clickedAtMs;
  const timeoutMs = 20_000;
  const stableMs = 400;
  while (Date.now() - clickedAtMs < timeoutMs) {
    const now = Date.now();
    const [heals, hash]: [Record<string, number>, number | null] = await Promise.all([
      healReason === null ? readWcHeals(page) : Promise.resolve(healsBefore),
      settleAt === null ? pixelHash(page) : Promise.resolve(lastHash),
    ]);
    if (healReason === null) {
      for (const [kind, count] of Object.entries(heals)) {
        if ((count ?? 0) > (healsBefore[kind] ?? 0)) {
          healReason = kind;
          msFromClickToHeal = now - clickedAtMs;
          console.log(`  heal fired: "${kind}" at +${msFromClickToHeal}ms after the seek click`);
          break;
        }
      }
    }
    if (settleAt === null) {
      if (hash !== lastHash) {
        if (firstChangeAt === null) firstChangeAt = now - clickedAtMs;
        lastHash = hash;
        lastChangeAt = now;
      } else if (firstChangeAt !== null && now - lastChangeAt >= stableMs) {
        settleAt = now - clickedAtMs;
      }
    }
    if (healReason !== null && settleAt !== null) break;
    await page.waitForTimeout(80);
  }

  const finalModes = await readWcModes(page);
  const finalMode = finalModes[subject.key];
  const demoted = finalMode === "element";

  console.log(`  picture: firstChange=${firstChangeAt}ms settle=${settleAt}ms timedOut=${settleAt === null}`);
  console.log(`  final mode: ${finalMode}  demoted: ${demoted}`);

  return {
    label, targetSeconds, subjectKey: subject.key, modeBeforeSeek, healReason, msFromClickToHeal,
    crossedWedgeThreshold: msFromClickToHeal === null ? null : msFromClickToHeal > WC_BUSY_WEDGE_MS,
    msFromClickToPictureFirstChange: firstChangeAt, msFromClickToPictureSettle: settleAt,
    pictureTimedOut: settleAt === null, demoted, finalMode, voidReason: null,
  };
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (channel !== "chrome") {
    console.log("REFUSING — PIXEL_BROWSER_CHANNEL=chrome is required (SwiftShader ~8fps voids this).");
    process.exit(1);
  }
  reportMachineState();

  const clip = defaultClipPath(Number(process.env.PROBE_MIN_SECONDS ?? 140));
  console.log(`seed clip: ${clip}`);
  console.log(`D3 keyframe reference (from prior round): 0.00, 8.33, 16.67, ... median GOP 8.333s`);
  console.log(`  FAR target: 16.37s (≈0.30s before the 16.67s keyframe — near-maximal decode-forward within the GOP starting at 8.33s)`);
  console.log(`  NEAR target: 8.63s (≈0.30s after the 8.33s keyframe — minimal decode-forward)`);

  let browser: Browser | null = null;
  let context: BrowserContext;
  if (process.env.PROBE_PROFILE) {
    context = await chromium.launchPersistentContext(process.env.PROBE_PROFILE, { channel, viewport: { width: 1600, height: 900 } });
  } else {
    browser = await chromium.launch({ channel });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");

  try {
    const projectUrl = await reachEditor(page, { clipPath: clip, flags: "wcDecode=1&kernelDiagnostics=1" });
    console.log(`\nproject: ${projectUrl}`);

    // FAR scenario doubles as F1/F2/F3 (chosen to reliably reproduce the demotion) and F4's far arm.
    const far = await runOneSeekScenario(page, projectUrl, "FAR-from-keyframe (F1/F2/F3 + F4 far arm)", 16.37);
    const near = await runOneSeekScenario(page, projectUrl, "NEAR-keyframe (F4 near arm)", 8.63);

    console.log(`\n\n══════════════════ SUMMARY ══════════════════`);
    for (const r of [far, near]) {
      console.log(`\n${r.label}  (target t=${r.targetSeconds}s)`);
      if (r.voidReason) {
        console.log(`  VOID — ${r.voidReason}`);
        continue;
      }
      console.log(`  heal reason: ${r.healReason ?? "(none fired)"}  ms-to-heal: ${r.msFromClickToHeal ?? "n/a"}  crossed ${WC_BUSY_WEDGE_MS}ms: ${r.crossedWedgeThreshold}`);
      console.log(`  picture: firstChange=${r.msFromClickToPictureFirstChange}ms settle=${r.msFromClickToPictureSettle}ms timedOut=${r.pictureTimedOut}`);
      console.log(`  demoted: ${r.demoted}  final mode: ${r.finalMode}`);
    }

    console.log(`\n── F1: WHICH FALLBACK FIRED ──`);
    console.log(`  FAR scenario heal reason: ${far.healReason ?? "(none — did not demote / no heal recorded)"}`);

    console.log(`\n── F2: THE ARITHMETIC ──`);
    console.log(`  FAR scenario: click→heal = ${far.msFromClickToHeal}ms  (threshold ${WC_BUSY_WEDGE_MS}ms)  crossed: ${far.crossedWedgeThreshold}`);

    console.log(`\n── F3: THE DEMOTING SEEK'S OWN TIME-TO-PICTURE ──`);
    console.log(`  FAR scenario: settle=${far.msFromClickToPictureSettle}ms (timedOut=${far.pictureTimedOut})`);

    console.log(`\n── F4: KEYFRAME CORRELATION ──`);
    console.log(`  NEAR (t=8.63s) demoted: ${near.demoted}   FAR (t=16.37s) demoted: ${far.demoted}`);
    const f4Confirmed = far.demoted === true && near.demoted === false;
    console.log(`  near survives / far demotes: ${f4Confirmed}`);

    let verdict: string;
    if (far.voidReason || near.voidReason) {
      verdict = "VOID for at least one scenario — see per-scenario reasons above.";
    } else if (far.healReason && far.healReason !== "busyWedge") {
      verdict = `WRONG SITE — the fallback that fired was "${far.healReason}", not busyWedge. The proposed mechanism is wrong; the fix (if any) is elsewhere.`;
    } else if (!far.demoted) {
      verdict = "The FAR scenario did not demote at all this run — cannot confirm or refute the mechanism from this reading.";
    } else {
      const f1 = far.healReason === "busyWedge";
      const f2 = far.crossedWedgeThreshold === true;
      const f3reported = far.msFromClickToPictureSettle !== null || far.pictureTimedOut;
      if (f1 && f2 && f4Confirmed) {
        verdict = `CONFIRMED — busyWedge fired, crossed ${WC_BUSY_WEDGE_MS}ms (${far.msFromClickToHeal}ms), near-keyframe survived while far-from-keyframe demoted. Complete chain from GOP structure to permanent demotion. Demoting seek's own time-to-picture: ${far.msFromClickToPictureSettle}ms${far.pictureTimedOut ? " (timed out)" : ""}.`;
      } else {
        const links = [`F1(busyWedge)=${f1}`, `F2(>${WC_BUSY_WEDGE_MS}ms)=${f2}`, `F3(reported)=${f3reported}`, `F4(near survives/far demotes)=${f4Confirmed}`];
        verdict = `PARTIAL — ${links.join(", ")}. Do not treat as a complete chain.`;
      }
    }
    console.log(`\nVERDICT: ${verdict}\n`);
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

const exitTimer = setTimeout(() => process.exit(0), 10 * 60_000);
exitTimer.unref();

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
