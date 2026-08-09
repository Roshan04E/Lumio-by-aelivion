/**
 * MEASUREMENT ONLY — G1-G4, testing whether a seek is even necessary for `pausedStall` to fire.
 *
 * F1-F4 (ruler-jump-wedge-confirm-probe.ts) found the demoting fallback was `pausedStall`
 * (WebglMediaLayer.tsx:2286-2298), gated by `wcHoldStartRef`/`streakMs`, not the seek-adjacent
 * `busyWedge`. F2's own arithmetic there showed the heal firing ~1260ms after the seek click against a
 * 3000ms threshold — meaning the hold streak had already been running ~1.74s BEFORE that seek. This
 * script tests the question that raises directly, instead of proposing another hypothesis: does
 * `pausedStall` fire with NO seek and NO transport activity at all, just sitting paused?
 *
 *   G1. Engage WebCodecs on the subject, then do NOTHING for 30s (no seek, no click). Sample
 *       `__rfWcMode` and `__rfWcHeals` as a timeline. Does `pausedStall` fire anyway?
 *   G2. If it fires with no seek: report when. (`lastFrameLagSeconds`/`wcHoldStartRef` are internal
 *       React-ref state, never published on `window` — reporting `lag` directly would require adding
 *       new production telemetry, which is out of scope for a measurement-only round. The demotion
 *       timing itself is what's reported instead.)
 *   G3. If it does NOT fire within 30s idle: the seek is required — fire exactly one (reusing the FAR
 *       target from the previous round) and report how long it then takes. Same telemetry-exposure
 *       limit applies to reporting the underlying `lag` value.
 *   G4. EITHER WAY: once a demotion has occurred (from G1 or the G3 fallback seek), reload the page (a
 *       full remount) and check whether the subject re-attempts and reaches a non-element mode. The
 *       paused fallback does NOT add to `wcBailedSources` (only the playing-case branch does, per the
 *       code's own comment) — so nothing in the source code should block a remount from retrying
 *       WebCodecs. If it does NOT recover on remount either, something else is holding it back and
 *       "permanent by accident" is the wrong read too.
 *
 * PRE-REGISTERED: PAUSED-ALONE (fires with no seek — the seek framing in every prior round was a
 * coincidence of timing) / SEEK-REQUIRED (does not fire idle; the seek genuinely matters) /
 * NEITHER-REPRODUCES (does not fire in this run at all — say so, this investigation has had shaky
 * reproduction before and a non-reproduction is itself a finding).
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker rulerjump:pausealone
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

/** Subject-scoped engagement wait — poll ONLY the subject's own key for non-element, never any-entry. */
async function awaitSubjectEngaged(page: Page, subjectKey: string, timeoutMs = 15_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const modes = await readWcModes(page);
    if (modes[subjectKey] && modes[subjectKey] !== "element") return true;
    await page.waitForTimeout(200);
  }
  return false;
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

  try {
    const projectUrl = await reachEditor(page, { clipPath: clip, flags: "wcDecode=1&kernelDiagnostics=1" });
    console.log(`\nproject: ${projectUrl}`);

    const subject = await awaitSubjectPoolAttempt(page);
    if (!subject) {
      console.log("VOID — the subject never attempted the pool within 240s.");
      return;
    }
    console.log(`subject key: ${subject.key}`);
    const engaged = await awaitSubjectEngaged(page, subject.key);
    console.log(`subject-scoped engagement: ${engaged}`);
    if (!engaged) {
      console.log("VOID — the subject never reached a non-element mode; nothing to test demotion against.");
      return;
    }

    // ── G1: sit paused, do NOTHING, for 30s. No clicks, no seeks, no calibration (calibration itself
    // clicks the ruler, which would BE a seek). ──────────────────────────────────────────────────
    console.log(`\n── G1: sampling __rfWcMode + __rfWcHeals for 30s with ZERO transport activity ──`);
    const healsBefore = await readWcHeals(page);
    const g1Start = Date.now();
    let g1Demoted = false;
    let g1DemotedAtMs: number | null = null;
    let g1HealReason: string | null = null;
    while (Date.now() - g1Start < 30_000) {
      const [modes, heals] = await Promise.all([readWcModes(page), readWcHeals(page)]);
      const m = modes[subject.key];
      if (!g1Demoted) {
        for (const [kind, count] of Object.entries(heals)) {
          if ((count ?? 0) > (healsBefore[kind] ?? 0)) {
            g1Demoted = true;
            g1DemotedAtMs = Date.now() - g1Start;
            g1HealReason = kind;
            console.log(`  DEMOTED with no seek — heal "${kind}" at t=${g1DemotedAtMs}ms into the idle window (mode now ${m})`);
            break;
          }
        }
      }
      if (g1Demoted) break;
      await page.waitForTimeout(300);
    }
    if (!g1Demoted) console.log(`  no heal fired during 30s of pure idle (still ${(await readWcModes(page))[subject.key]})`);

    // ── G3 fallback: if idle alone did not demote it, fire exactly ONE seek to reach a demoted state
    // (needed for G4 regardless of the G1/G2 outcome). ──────────────────────────────────────────
    let reachedDemotionVia: "idle" | "seek" | "neither" = g1Demoted ? "idle" : "neither";
    let seekHealReason: string | null = null;
    let seekMsToHeal: number | null = null;
    if (!g1Demoted) {
      console.log(`\n── G3: idle alone did not demote it — firing ONE seek to reach a demoted state for G4 ──`);
      const cal = await calibrateRuler(page);
      if (cal) {
        await seekToSeconds(page, cal, 2);
        await page.waitForTimeout(1_000);
        const healsBefore2 = await readWcHeals(page);
        const clickedAt = Date.now();
        await seekToSeconds(page, cal, 16.37);
        const seekTimeoutStart = Date.now();
        while (Date.now() - seekTimeoutStart < 20_000) {
          const heals = await readWcHeals(page);
          let fired = false;
          for (const [kind, count] of Object.entries(heals)) {
            if ((count ?? 0) > (healsBefore2[kind] ?? 0)) {
              seekHealReason = kind;
              seekMsToHeal = Date.now() - clickedAt;
              fired = true;
              console.log(`  heal "${kind}" fired ${seekMsToHeal}ms after the seek`);
              break;
            }
          }
          if (fired) {
            reachedDemotionVia = "seek";
            break;
          }
          await page.waitForTimeout(150);
        }
        if (reachedDemotionVia === "neither") console.log(`  the fallback seek ALSO did not demote within 20s — pausedStall did not reproduce this run.`);
      } else {
        console.log(`  ruler calibration failed — cannot fire the fallback seek.`);
      }
    }

    const finalModesBeforeReload = await readWcModes(page);
    console.log(`\nfinal mode for subject before G4: ${finalModesBeforeReload[subject.key]}`);
    console.log(`reached a demoted state via: ${reachedDemotionVia}`);

    // ── G4: does a REMOUNT (full page reload — the cheapest guaranteed remount) restore WebCodecs? ──
    let g4Recovered: boolean | null = null;
    if (reachedDemotionVia !== "neither") {
      console.log(`\n── G4: reloading (remount) — does the subject re-attempt and reach a non-element mode? ──`);
      await page.goto(projectUrl.split("?")[0] + "?wcDecode=1&kernelDiagnostics=1", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2_500);
      const newSubject = await awaitSubjectPoolAttempt(page, 60_000);
      if (!newSubject) {
        console.log(`  the subject never attempted the pool again after reload within 60s.`);
        g4Recovered = false;
      } else {
        console.log(`  post-reload subject key: ${newSubject.key}`);
        g4Recovered = await awaitSubjectEngaged(page, newSubject.key, 15_000);
        console.log(`  reached non-element mode after remount: ${g4Recovered}`);
      }
    } else {
      console.log(`\nG4 skipped — no demotion occurred to test recovery from.`);
    }

    console.log(`\n\n══════════════════ SUMMARY ══════════════════`);
    console.log(`G1 (idle 30s, no seek): demoted=${g1Demoted}${g1Demoted ? ` reason=${g1HealReason} at +${g1DemotedAtMs}ms` : ""}`);
    if (!g1Demoted) {
      console.log(`G3 (one fallback seek): reachedDemotion=${reachedDemotionVia === "seek"}${seekHealReason ? ` reason=${seekHealReason} at +${seekMsToHeal}ms` : ""}`);
    }
    console.log(`G2/G3 lag value: NOT reportable — lastFrameLagSeconds/wcHoldStartRef are internal refs, never published on window. Reporting demotion timing only, per this round's no-new-telemetry constraint.`);
    console.log(`G4 (remount recovery): ${reachedDemotionVia === "neither" ? "n/a (nothing to recover from)" : g4Recovered}`);

    let verdict: string;
    if (g1Demoted) {
      verdict = `PAUSED-ALONE — pausedStall ("${g1HealReason}") fired after ${g1DemotedAtMs}ms of pure idle, no seek involved. The seek framing in the last three rounds was a coincidence of timing. Remount recovery: ${g4Recovered}.`;
    } else if (reachedDemotionVia === "seek") {
      verdict = `SEEK-REQUIRED — no demotion in 30s idle; the fallback seek demoted it in ${seekMsToHeal}ms (reason "${seekHealReason}"). The seek genuinely matters. Remount recovery: ${g4Recovered}.`;
    } else {
      verdict = `NEITHER-REPRODUCES — no demotion from 30s idle NOR from a follow-up seek in this run. Reproducibility issue, reported as its own finding rather than forced into either category.`;
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
