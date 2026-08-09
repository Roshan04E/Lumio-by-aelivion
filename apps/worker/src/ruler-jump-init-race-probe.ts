/**
 * MEASUREMENT ONLY — E1-E4, testing the strongest hypothesis yet for the founder's 4-5s paused-seek
 * delay: a seek arriving while a freshly-created WebCodecs session is still initializing
 * (`session.ready` is a promise, not instant) triggers `wcFallbackRef`'s async bail to `element`. Its
 * predecessors (distance, keyframes, contention, self-starvation) are refuted by ruler-jump-delay-probe.ts
 * and ruler-jump-cap-audit.ts. This one's trigger is SEEKING, which is what the founder actually does.
 *
 *   E1. EARLY SEEK — fire ONE seek at t≈500ms after the subject's pool-route decision, while the
 *       session is plausibly still initializing. Does __rfWcMode[subjectKey] drop to "element"?
 *   E2. LATE SEEK (the discriminator) — same, but at t≈10s, well after ruler-jump-cap-audit.ts showed
 *       the session settled and steady. E1-demotes/E2-doesn't isolates the init window specifically;
 *       both demoting means seeks demote in general; neither demoting refutes this hypothesis too.
 *   E3. PERMANENCE — if either demotes, keep sampling AND keep seeking for 30 more seconds. Does the
 *       subject ever return to a non-element mode, or is it element for the rest of the session
 *       (DEBT-013's "denied and never re-admitted" terminal)?
 *   E4. USER-VISIBLE COST — the canvas pixel-hash instrument (ruler-jump-delay-probe.ts's technique),
 *       timing one seek in whichever mode each scenario ends in, tagged with that mode. Closes the loop
 *       from "which decode path" to "how many seconds does it cost".
 *
 * PRE-REGISTERED: CONFIRMED (E1 demotes, E2 doesn't, demotion persists, element seeks cost seconds vs
 * wc-hw's tens of ms) / PARTIAL (report which links hold) / REFUTED (neither demotes — stop, no sixth
 * hypothesis) / VOID (subject never reached a non-element mode before the test seek, or routing moved
 * underneath the measurement — both asserted explicitly per scenario).
 *
 * NOT a fix. If E1 confirms, the mechanism is reported and nothing in session-lifecycle code changes
 * this round.
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker rulerjump:initrace
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

interface RoutingEntry {
  at: number;
  route: "element" | "pool";
  preferNativeDecode: boolean;
  bailed: boolean;
  tolerateLag: boolean;
  hidden: boolean;
}

async function readRouting(page: Page): Promise<Record<string, RoutingEntry[]>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfRouting ?? {}) }));
}
async function readWcModes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfWcMode ?? {}) }));
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

async function measureJump(
  page: Page,
  cal: NonNullable<Awaited<ReturnType<typeof calibrateRuler>>>,
  seconds: number,
  timeoutMs = 20_000,
  stableMs = 400
): Promise<{ msToSettle: number | null; timedOut: boolean }> {
  const before = await page.evaluate(() => (window as unknown as { __jumpProbe: { hash: () => number | null } }).__jumpProbe.hash());
  await seekToSeconds(page, cal, seconds);
  const clickedAt = Date.now();
  let firstChangeAt: number | null = null;
  let lastHash = before;
  let lastChangeAt = clickedAt;
  while (Date.now() - clickedAt < timeoutMs) {
    const h = await page.evaluate(() => (window as unknown as { __jumpProbe: { hash: () => number | null } }).__jumpProbe.hash());
    const now = Date.now();
    if (h !== lastHash) {
      if (firstChangeAt === null) firstChangeAt = now;
      lastHash = h;
      lastChangeAt = now;
    } else if (firstChangeAt !== null && now - lastChangeAt >= stableMs) {
      return { msToSettle: now - clickedAt, timedOut: false };
    }
    await page.waitForTimeout(80);
  }
  return { msToSettle: null, timedOut: true };
}

/** Poll at a fixed fast interval throughout — a project RELOAD (used between E1/E2 scenarios so the
 *  already-built proxy resolves from OPFS instead of re-transcoding) lands the pool-route entry at an
 *  unpredictable, usually much earlier, time than the first-ever load, so no slow-then-fast heuristic
 *  is safe here. 150ms keeps detection close enough to the entry's own timestamp for E1's t≈500ms
 *  precision without costing much over a run that is a few minutes long regardless. */
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

interface ScenarioResult {
  label: string;
  subjectKey: string;
  modeBeforeSeek: string | undefined;
  seekFiredAtOffsetMs: number;
  demoted: boolean;
  demotedAtOffsetMs: number | null;
  permanentAfter30s: boolean | null;
  recoveredAtOffsetMs: number | null;
  finalMode: string | undefined;
  e4: { mode: string | undefined; msToSettle: number | null; timedOut: boolean } | null;
  voidReason: string | null;
}

async function runScenario(page: Page, projectUrl: string, label: string, seekDelayTargetMs: number): Promise<ScenarioResult> {
  console.log(`\n═══ ${label} (test seek at t≈${seekDelayTargetMs}ms after the pool-route decision) ═══`);
  await page.goto(projectUrl.split("?")[0] + "?wcDecode=1&kernelDiagnostics=1", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_500);
  await installPixelProbe(page);

  const subject = await awaitSubjectPoolAttempt(page);
  if (!subject) {
    return {
      label, subjectKey: "", modeBeforeSeek: undefined, seekFiredAtOffsetMs: -1, demoted: false, demotedAtOffsetMs: null,
      permanentAfter30s: null, recoveredAtOffsetMs: null, finalMode: undefined, e4: null,
      voidReason: "subject never attempted the pool within 240s",
    };
  }
  console.log(`  subject key: ${subject.key}  (pool-route entry at browser-t=${subject.entryAtMs}ms)`);

  const elapsedSinceEntry = (await nowBrowser(page)) - subject.entryAtMs;
  const waitMore = Math.max(0, seekDelayTargetMs - elapsedSinceEntry);
  await page.waitForTimeout(waitMore);
  const modeBeforeSeek = (await readWcModes(page))[subject.key];
  const actualOffsetAtSeek = (await nowBrowser(page)) - subject.entryAtMs;
  console.log(`  mode immediately before test seek: ${modeBeforeSeek ?? "(absent)"}  (actual offset ${actualOffsetAtSeek.toFixed(0)}ms)`);

  if (!modeBeforeSeek || modeBeforeSeek === "element") {
    // VOID per the pre-registered condition: nothing to demote.
    console.log(`  VOID for this scenario — subject was already on 'element' before the test seek (nothing to demote).`);
    return {
      label, subjectKey: subject.key, modeBeforeSeek, seekFiredAtOffsetMs: actualOffsetAtSeek, demoted: false, demotedAtOffsetMs: null,
      permanentAfter30s: null, recoveredAtOffsetMs: null, finalMode: modeBeforeSeek, e4: null,
      voidReason: "subject was on 'element' (not yet engaged) at the moment the test seek fired",
    };
  }

  const cal = await calibrateRuler(page);
  if (!cal) {
    return {
      label, subjectKey: subject.key, modeBeforeSeek, seekFiredAtOffsetMs: actualOffsetAtSeek, demoted: false, demotedAtOffsetMs: null,
      permanentAfter30s: null, recoveredAtOffsetMs: null, finalMode: modeBeforeSeek, e4: null,
      voidReason: "ruler calibration failed",
    };
  }

  // THE TEST SEEK — untimed, just a click to a nearby point, exactly the action the founder performs.
  await seekToSeconds(page, cal, 8);

  // Sample the mode for 10s to see whether/when it demotes.
  let demoted = false;
  let demotedAtOffsetMs: number | null = null;
  const sampleStart = Date.now();
  while (Date.now() - sampleStart < 10_000) {
    const modes = await readWcModes(page);
    const m = modes[subject.key];
    if (m === "element" && !demoted) {
      demoted = true;
      demotedAtOffsetMs = Date.now() - sampleStart;
      console.log(`  DEMOTED to element at +${demotedAtOffsetMs}ms after the test seek`);
      break;
    }
    await page.waitForTimeout(150);
  }
  if (!demoted) console.log(`  did not demote within 10s of the test seek`);

  // ── E3: permanence, only if it demoted — keep sampling AND keep (gently) seeking for 30s more. ──
  let permanentAfter30s: boolean | null = null;
  let recoveredAtOffsetMs: number | null = null;
  if (demoted) {
    console.log(`  E3: sampling + reseeking every 5s for 30s more, watching for recovery...`);
    const permStart = Date.now();
    let recovered = false;
    let nextSeekTarget = 12;
    while (Date.now() - permStart < 30_000) {
      await page.waitForTimeout(5_000);
      await seekToSeconds(page, cal, nextSeekTarget);
      nextSeekTarget = nextSeekTarget === 12 ? 16 : 12;
      const modes = await readWcModes(page);
      const m = modes[subject.key];
      if (m && m !== "element" && !recovered) {
        recovered = true;
        recoveredAtOffsetMs = Date.now() - permStart;
        console.log(`  RECOVERED to ${m} at +${recoveredAtOffsetMs}ms into the permanence window`);
      }
    }
    permanentAfter30s = !recovered;
    console.log(`  permanent (never recovered in 30s): ${permanentAfter30s}`);
  }

  // ── E4: user-visible cost — one timed seek in whichever mode we ended in. ──
  const finalModes = await readWcModes(page);
  const finalMode = finalModes[subject.key];
  const e4target = finalMode === "element" || demoted ? 20 : 8; // distinct target so it's a real seek
  const e4 = await measureJump(page, cal, e4target);
  console.log(`  E4: seek latency while mode=${finalMode ?? "(absent)"}: settle=${e4.msToSettle}ms timedOut=${e4.timedOut}`);

  return {
    label, subjectKey: subject.key, modeBeforeSeek, seekFiredAtOffsetMs: actualOffsetAtSeek, demoted, demotedAtOffsetMs,
    permanentAfter30s, recoveredAtOffsetMs, finalMode, e4: { mode: finalMode, msToSettle: e4.msToSettle, timedOut: e4.timedOut },
    voidReason: null,
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

    const e1 = await runScenario(page, projectUrl, "E1 — EARLY seek (~500ms into init)", 500);
    const e2 = await runScenario(page, projectUrl, "E2 — LATE seek (~10s, session settled)", 10_000);

    console.log(`\n\n══════════════════ SUMMARY ══════════════════`);
    for (const r of [e1, e2]) {
      console.log(`\n${r.label}`);
      if (r.voidReason) {
        console.log(`  VOID — ${r.voidReason}`);
        continue;
      }
      console.log(`  mode before test seek: ${r.modeBeforeSeek}  (seek fired at actual offset ${r.seekFiredAtOffsetMs.toFixed(0)}ms)`);
      console.log(`  demoted to element: ${r.demoted}${r.demoted ? ` (at +${r.demotedAtOffsetMs}ms after the seek)` : ""}`);
      if (r.demoted) {
        console.log(`  permanent for 30s: ${r.permanentAfter30s}${r.recoveredAtOffsetMs != null ? ` (recovered at +${r.recoveredAtOffsetMs}ms)` : ""}`);
      }
      console.log(`  final mode: ${r.finalMode}`);
      if (r.e4) console.log(`  E4 latency @ mode=${r.e4.mode}: settle=${r.e4.msToSettle}ms timedOut=${r.e4.timedOut}`);
    }

    const e1Demoted = e1.demoted;
    const e2Demoted = e2.demoted;
    let verdict: string;
    if (e1.voidReason || e2.voidReason) {
      verdict = "VOID for at least one scenario — see per-scenario reasons above.";
    } else if (e1Demoted && !e2Demoted) {
      verdict = "CONFIRMED (subject to E3/E4 detail above) — early seek demotes, late seek does not: the vulnerable window is session init.";
    } else if (e1Demoted && e2Demoted) {
      verdict = "PARTIAL — both demote. Seeks demote in general, not specifically an init-window race. Larger defect than proposed.";
    } else if (!e1Demoted && !e2Demoted) {
      verdict = "REFUTED — neither the early nor the late seek demoted the subject. This hypothesis does not explain the prior round's element-ending state. Stopping; not hunting a sixth hypothesis.";
    } else {
      verdict = "PARTIAL — late seek demoted but early did not (unexpected direction) — report as-is, do not force it into CONFIRMED.";
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
