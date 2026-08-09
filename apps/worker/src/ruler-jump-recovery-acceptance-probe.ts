/**
 * MEASUREMENT ONLY — acceptance for the paused WC recovery ladder added to WebglMediaLayer.tsx
 * (MAX_PAUSED_WC_RECOVERY_ATTEMPTS / PAUSED_WC_RECOVERY_BACKOFF_MS / scheduleWcPausedRecovery). Three
 * pre-registered readings, all required:
 *
 *   A1. RECOVERY — after a demoting seek, does the subject return to a non-element mode within the
 *       ladder's own bound (without a reload)? Report the time.
 *   A2. NO THRASH — fire repeated seeks (>=10 over 60s) and report the scheduled-attempt count (via the
 *       ladder's own console.warn lines, captured live) and the final mode. Must not exceed
 *       MAX_PAUSED_WC_RECOVERY_ATTEMPTS scheduled attempts however many stalls occur.
 *   A3. THE BOUND TERMINATES — after A2 has (expectedly) exhausted the budget, fire more seeks and
 *       confirm NO further recovery attempts are scheduled and the mode stays on element — proving the
 *       ladder gives up rather than never having been tested to.
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker rulerjump:recoveryaccept
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

async function awaitSubjectPoolAttempt(page: Page, timeoutMs = 240_000): Promise<{ key: string } | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const routing = await readRouting(page);
    for (const [key, entries] of Object.entries(routing)) {
      if (entries.some((e) => e.route === "pool")) return { key };
    }
    await page.waitForTimeout(150);
  }
  return null;
}
async function awaitSubjectEngaged(page: Page, subjectKey: string, timeoutMs = 15_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const modes = await readWcModes(page);
    if (modes[subjectKey] && modes[subjectKey] !== "element") return true;
    await page.waitForTimeout(200);
  }
  return false;
}

interface LadderLogLine { atMs: number; text: string; }

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (channel !== "chrome") {
    console.log("REFUSING — PIXEL_BROWSER_CHANNEL=chrome is required (SwiftShader ~8fps voids this).");
    process.exit(1);
  }
  reportMachineState();

  const clip = defaultClipPath(Number(process.env.PROBE_MIN_SECONDS ?? 140));
  console.log(`seed clip: ${clip}`);

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

  const runStarted = Date.now();
  const ladderLog: LadderLogLine[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("paused WC recovery")) ladderLog.push({ atMs: Date.now() - runStarted, text });
  });

  try {
    const projectUrl = await reachEditor(page, { clipPath: clip, flags: "wcDecode=1&kernelDiagnostics=1" });
    console.log(`\nproject: ${projectUrl}`);

    const subject = await awaitSubjectPoolAttempt(page);
    if (!subject) {
      console.log("VOID — subject never attempted the pool within 240s.");
      return;
    }
    console.log(`subject key: ${subject.key}`);
    if (!(await awaitSubjectEngaged(page, subject.key))) {
      console.log("VOID — subject never reached a non-element mode.");
      return;
    }
    await page.waitForTimeout(10_000); // settle, matching prior rounds' convention

    const cal = await calibrateRuler(page);
    if (!cal) {
      console.log("VOID — ruler calibration failed.");
      return;
    }
    await seekToSeconds(page, cal, 2);
    await page.waitForTimeout(1_500);

    // ── A1: RECOVERY ──────────────────────────────────────────────────────────────────────
    console.log(`\n── A1: RECOVERY ──`);
    const modeBefore = (await readWcModes(page))[subject.key];
    console.log(`  mode before test seek: ${modeBefore}`);
    const seekedAt = Date.now();
    await seekToSeconds(page, cal, 16.37);
    let demotedAtMs: number | null = null;
    let recoveredAtMs: number | null = null;
    const a1Deadline = Date.now() + 20_000;
    while (Date.now() < a1Deadline) {
      const m = (await readWcModes(page))[subject.key];
      if (demotedAtMs === null && m === "element") demotedAtMs = Date.now() - seekedAt;
      if (demotedAtMs !== null && m && m !== "element") {
        recoveredAtMs = Date.now() - seekedAt;
        break;
      }
      await page.waitForTimeout(150);
    }
    console.log(`  demoted at +${demotedAtMs}ms, recovered at +${recoveredAtMs}ms (null = did not recover within 20s)`);
    console.log(`  ladder log so far: ${JSON.stringify(ladderLog)}`);

    // ── A2: NO THRASH — repeated seeks over 60s ─────────────────────────────────────────────
    // A1's single 2→16.37 jump reliably triggers pausedStall; a SPREAD-OUT alternation between two
    // near points (as originally tried) mostly doesn't, because once settled near 16.37 a small hop to
    // 8.63 and back is not the large decode-catch-up jump that trips the hold in the first place — it
    // measures "does the ladder attempt a lot for TINY seeks" rather than "does it stay bounded when
    // the SAME triggering jump repeats". Reproducing the actual trigger (2 → 16.37, the same pair A1
    // used) is what makes A2/A3 mean something.
    console.log(`\n── A2: NO THRASH (repeated 2↔16.37 seeks, at least 10 over 60s) ──`);
    const a2Start = Date.now();
    let seekCount = 0;
    while (Date.now() - a2Start < 60_000) {
      await seekToSeconds(page, cal, 2);
      await page.waitForTimeout(700);
      await seekToSeconds(page, cal, 16.37);
      seekCount += 1;
      await page.waitForTimeout(2_500);
    }
    const healsAfterA2 = await readWcHeals(page);
    const modeAfterA2 = (await readWcModes(page))[subject.key];
    const attemptLines = ladderLog.filter((l) => l.text.includes(" attempt "));
    const exhaustedLines = ladderLog.filter((l) => l.text.includes("exhausted"));
    console.log(`  2→16.37 cycles fired: ${seekCount}`);
    console.log(`  pausedStall count: ${healsAfterA2.pausedStall ?? 0}`);
    console.log(`  ladder "attempt" lines: ${attemptLines.length}  (bound: ${3})`);
    console.log(`  ladder "exhausted" lines: ${exhaustedLines.length}`);
    console.log(`  final mode after A2: ${modeAfterA2}`);
    for (const l of ladderLog) console.log(`    t=${l.atMs}ms  ${l.text}`);

    // ── A3: THE BOUND TERMINATES ────────────────────────────────────────────────────────────
    // A first attempt at this (repeating the SAME 2→16.37 jump) found the source stopped restalling
    // after ~3 reps — almost certainly the decoder warming up on that one specific region, not evidence
    // of an unbounded ladder. To force the condition to persist rather than let it locally converge,
    // cycle through DISTINCT far targets (each ~0.3s before its own preceding keyframe, per D3's table)
    // so every jump is a fresh maximal decode-catch-up the pool has not just warmed up for, fired in
    // TIGHT succession (well inside the ladder's own backoff window) so a freshly-reacquired session
    // never gets the chance to settle before the next stall.
    console.log(`\n── A3: THE BOUND TERMINATES (tight-cycle forcing across distinct far targets) ──`);
    const farTargets = [16.37, 24.7, 33.03, 41.37, 44.99, 53.33, 61.67, 70.0, 78.33, 86.67];
    const attemptLinesBeforeA3 = attemptLines.length;
    let a3Cycles = 0;
    let sawExhausted = exhaustedLines.length > 0;
    while (a3Cycles < 30 && !sawExhausted) {
      await seekToSeconds(page, cal, 2);
      await page.waitForTimeout(150);
      await seekToSeconds(page, cal, farTargets[a3Cycles % farTargets.length]!);
      a3Cycles += 1;
      await page.waitForTimeout(400);
      sawExhausted = ladderLog.some((l) => l.text.includes("exhausted"));
    }
    console.log(`  tight cycles fired before exhaustion observed (or cap 30): ${a3Cycles}`);
    console.log(`  "exhausted" line seen: ${sawExhausted}`);
    // Now that the budget should be spent, fire several MORE cycles and confirm NO further attempts.
    const attemptLinesAtExhaustion = ladderLog.filter((l) => l.text.includes(" attempt ")).length;
    for (let i = 0; i < 5; i += 1) {
      await seekToSeconds(page, cal, 2);
      await page.waitForTimeout(150);
      await seekToSeconds(page, cal, farTargets[(a3Cycles + i) % farTargets.length]!);
      await page.waitForTimeout(400);
    }
    const attemptLinesAfterA3 = ladderLog.filter((l) => l.text.includes(" attempt ")).length;
    const modeAfterA3 = (await readWcModes(page))[subject.key];
    console.log(`  attempts at exhaustion: ${attemptLinesAtExhaustion}  attempts after 5 more forced cycles: ${attemptLinesAfterA3}`);
    console.log(`  mode after A3: ${modeAfterA3}`);
    const bounded = attemptLinesAtExhaustion <= 3 && attemptLinesAfterA3 === attemptLinesAtExhaustion && sawExhausted;
    console.log(`  bound held (<=3 total attempts, "exhausted" observed, zero more attempts after): ${bounded}`);

    console.log(`\n\n══════════════════ SUMMARY ══════════════════`);
    console.log(`A1 recovery time: ${recoveredAtMs}ms (demoted at ${demotedAtMs}ms)`);
    console.log(`A2 cycles=${seekCount} pausedStall=${healsAfterA2.pausedStall ?? 0} attempts=${attemptLines.length} exhausted=${exhaustedLines.length > 0} finalMode=${modeAfterA2}`);
    console.log(`A3 bounded=${bounded} sawExhausted=${sawExhausted} finalMode=${modeAfterA3}`);
    console.log(`\nfull ladder console log (${ladderLog.length} lines):`);
    for (const l of ladderLog) console.log(`  t=${l.atMs}ms  ${l.text}`);
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
