/**
 * MEASUREMENT ONLY — follow-up to ruler-jump-delay-probe.ts's D4.
 *
 * D4 took ONE end-of-run snapshot of `__rfWcMode` and found the tested source on `element` despite
 * `awaitWebCodecsEngaged` having reported "engaged". Those are compatible, not contradictory:
 * `awaitWebCodecsEngaged` (editor-session.ts:483) asks whether ANY entry in `__rfWcMode` is off the
 * element path, never whether THE SOURCE UNDER TEST is. A single-source fixture can satisfy that
 * predicate on a transient/unrelated entry while the actual subject never engages. If that happened
 * here, D1/D2 measured native `<video>` seek cost, not the app's WebCodecs pipeline, and the real
 * question stops being "why is seeking slow" and becomes "why did this source stay on element".
 *
 * This script does NOT re-run D1/D2's timed sweeps (those numbers are set aside, not discarded, per
 * this round's instructions). It answers three questions instead:
 *
 *   R1. ROUTING, AS A TIMELINE — not sampled, READ. `WebglMediaLayer.tsx` already keeps an append-only,
 *       timestamped log per source URL at `__rfRouting[key]`, pushed on every mount/remount evaluation
 *       with its full inputs (`route`, `preferNativeDecode`, `bailed`, `tolerateLag`, `hidden`). That is
 *       a real timeline already, not something this probe needs to poll for — polling would only add
 *       observer-effect risk for no extra signal. Read it in full at the end.
 *   R2. DOES AN INGEST PROXY EXIST FOR THIS ASSET — not "did the built count change" (that answers a
 *       different question, per this round's brief). This project has exactly one asset (the single
 *       upload from reachEditor), so any `[source-proxy] <assetId>: <outcome>` console line — captured
 *       live via `page.on('console')` after flipping `localStorage.orreris.perfLog=1` — is unambiguously
 *       about the tested asset. `sourceProxyEngine.ts`'s `record()`/`logProxy()` are the only writers.
 *   R3. IF blocked, why — read directly off the `note` field on a `skipped`/`failed` outcome, or off the
 *       captured log's own sequence (queued → building → outcome), rather than guessed.
 *
 * PRE-REGISTERED (unchanged from the D4 brief):
 *   ELEMENT-ROUTED, NO PROXY  — no built/failed/skipped outcome ever recorded, routing log is
 *     `preferNativeDecode: true` throughout. Then the founder's 4-5s is native <video> seek cost.
 *   ENGAGED THEN FELL BACK    — a proxy WAS built, but the routing log shows `bailed: true` or
 *     `preferNativeDecode: true` on a LATER entry after an earlier `route: "pool"` entry. Then
 *     something evicted it — DEBT-013's "denied and never re-admitted" is the first place to look.
 *   ENGAGED THROUGHOUT        — the tested source's key shows `route: "pool"` on every entry, and the
 *     `element` row in `__rfWcMode` belongs to a DIFFERENT (stale-cleanup or transient) key. Then D4's
 *     single sample was misleading and D1/D2 stand as WebCodecs measurements.
 *
 * PRECONDITIONS: PIXEL_BROWSER_CHANNEL=chrome. Machine state reported immediately before the run.
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker rulerjump:pathaudit
 */
import os from "node:os";
import { execSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { awaitWebCodecsEngaged, defaultClipPath, reachEditor } from "./browser/editor-session";

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

interface ProxyLogLine {
  atMs: number;
  text: string;
}

interface RoutingEntry {
  at: number;
  route: "element" | "pool";
  preferNativeDecode: boolean;
  bailed: boolean;
  tolerateLag: boolean;
  hidden: boolean;
}

async function readWcModes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfWcMode ?? {}) }));
}

async function readRouting(page: Page): Promise<Record<string, RoutingEntry[]>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfRouting ?? {}) }));
}

async function readProxyStats(page: Page) {
  return page.evaluate(() => {
    const s = (globalThis as Record<string, any>).__rfSourceProxy ?? {};
    return {
      built: Number(s.built ?? 0),
      failed: Number(s.failed ?? 0),
      skipped: Number(s.skipped ?? 0),
      queued: Number(s.queued ?? 0),
      active: (s.active ?? null) as string | null,
      recent: Array.isArray(s.recent) ? (s.recent as Array<{ assetId: string; outcome: string; ms: number; note?: string }>) : [],
    };
  });
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
  // R2/R3 instrument: sourceProxyEngine.ts's record()/logProxy() only console.info when this flag is
  // set. Setting it in an init script (before any page script runs) ensures we don't miss the very
  // first transitions, which fired ~seconds after the earlier run's navigation.
  await page.addInitScript("try { localStorage.setItem('orreris.perfLog', '1'); } catch {}");

  const runStarted = Date.now();
  const proxyLog: ProxyLogLine[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[source-proxy]")) proxyLog.push({ atMs: Date.now() - runStarted, text });
  });

  try {
    const projectUrl = await reachEditor(page, { clipPath: clip, flags: "wcDecode=1&kernelDiagnostics=1" });
    console.log(`\nproject: ${projectUrl}`);

    // Wait for the proxy to resolve one way or another (built/failed/skipped), reported via the SAME
    // console capture used for R2/R3 rather than a separate poll — one instrument, not two disagreeing
    // ones.
    const proxyStats = async () => readProxyStats(page);
    const before = await proxyStats();
    const deadline = Date.now() + 240_000;
    let outcomeSeen: "built" | "failed" | "skipped" | "timeout" = "timeout";
    while (Date.now() < deadline) {
      const now = await proxyStats();
      if (now.built > before.built) { outcomeSeen = "built"; break; }
      if (now.failed > before.failed) { outcomeSeen = "failed"; break; }
      if (now.skipped > before.skipped) { outcomeSeen = "skipped"; break; }
      await page.waitForTimeout(1_000);
    }
    console.log(`proxy resolution: ${outcomeSeen}`);
    // Give the app a moment to act on a successful build (swap mediaUrl, remount the layer) before we
    // read routing — this is the transition R1 exists to observe, not something to race past.
    await page.waitForTimeout(3_000);

    // NOT a timed measurement — a correctness precondition per this round's instrument note: check
    // whether THIS run ever got a non-"element" entry at all, informationally only (not gating anything
    // below; R1 reads the full log regardless).
    const engagedAnyEntry = await awaitWebCodecsEngaged(page, 5_000).catch(() => false);
    console.log(`awaitWebCodecsEngaged (any-entry predicate, informational only): ${engagedAnyEntry}`);

    const cal = await calibrateRuler(page);
    if (cal) {
      // Two cheap, UNTIMED seeks — not a distance/position sweep, just enough remount activity for R1's
      // routing log to have more than the initial-mount entry to read.
      await seekToSeconds(page, cal, 5);
      await page.waitForTimeout(1_500);
      await seekToSeconds(page, cal, 20);
      await page.waitForTimeout(1_500);
    } else {
      console.log("(ruler calibration failed — proceeding with whatever routing history exists from mount alone)");
    }

    const modes = await readWcModes(page);
    const routing = await readRouting(page);
    const finalProxy = await readProxyStats(page);

    console.log(`\n── R1: ROUTING, AS A TIMELINE (__rfRouting, full log per key) ──`);
    const keys = Object.keys(routing);
    if (keys.length === 0) console.log("  (no routing entries recorded)");
    for (const key of keys) {
      console.log(`  key ${key}:`);
      for (const entry of routing[key]!) {
        console.log(
          `    t=${entry.at}ms  route=${entry.route}  preferNativeDecode=${entry.preferNativeDecode}  bailed=${entry.bailed}  tolerateLag=${entry.tolerateLag}  hidden=${entry.hidden}`
        );
      }
    }

    console.log(`\n  __rfWcMode (final): ${JSON.stringify(modes)}`);

    console.log(`\n── R2: DOES AN INGEST PROXY EXIST FOR THIS ASSET ──`);
    console.log(`  final __rfSourceProxy: built=${finalProxy.built} failed=${finalProxy.failed} skipped=${finalProxy.skipped} queued=${finalProxy.queued} active=${finalProxy.active}`);
    console.log(`  recent[]: ${JSON.stringify(finalProxy.recent)}`);
    console.log(`  captured console [source-proxy] lines (${proxyLog.length}):`);
    for (const line of proxyLog) console.log(`    t=${line.atMs}ms  ${line.text}`);

    console.log(`\n── R3: IF BLOCKED, WHY (derived from R2's note fields / sequence, not guessed) ──`);
    if (finalProxy.recent.length === 0 && proxyLog.length === 0) {
      console.log("  no proxy build was ever recorded for this asset — never requested, or requested but never resolved within 240s.");
    } else {
      for (const r of finalProxy.recent) {
        console.log(`  asset ${r.assetId}: ${r.outcome}${r.note ? ` — ${r.note}` : ""} (${r.ms}ms)`);
      }
    }

    console.log(`\n── INSTRUMENT NOTE (named, not fixed this round) ──`);
    console.log(
      "  awaitWebCodecsEngaged(page) returns true when ANY __rfWcMode entry is non-'element' — correct for a\n" +
        "  multi-source fixture where 'did the budget fill at all' is the question, wrong for a single-subject\n" +
        "  probe. The right predicate for a single-subject probe is keyed on the SUBJECT: resolve the tested\n" +
        "  asset's own current __rfRouting/__rfWcMode key (available once, right after the layer mounts — the\n" +
        "  routing log entry's own key is the mediaUrl in effect at that moment) and poll THAT key for\n" +
        "  route==='pool', not 'globalThis has any pool entry at all'. This still asserts the mechanism ran\n" +
        "  for the subject under test, never that the subject merely coexisted with something else that engaged."
    );

    console.log(`\n(R1/R2/R3 reported separately, per this round's brief. Not re-running D1/D2.)\n`);
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

const exitTimer = setTimeout(() => process.exit(0), 6 * 60_000);
exitTimer.unref();

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
