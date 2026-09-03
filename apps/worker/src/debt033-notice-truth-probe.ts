/**
 * DEBT-033 — DOES THE PRODUCT'S OWN STORY MATCH THE CANVAS?
 *
 * This chapter's rule: a claim about what the user SEES needs a measurement taken WHERE THE USER
 * LOOKS. `flarex-canvas-truth-probe.ts` established that for the freeze itself. This probe applies the
 * same rule one layer up, to the things the product SAYS about the freeze:
 *
 *   A notice asserting readiness while the canvas is frozen is the same defect as a delivery counter
 *   reading 67fps while the canvas is frozen. Both count something true about the internals and
 *   report it as if it were the user's experience.
 *
 * So the instrument samples, at the SAME instants: the preview canvas bytes (hashed — the ground
 * truth), the toast text, the preview's proxy-state overlay, the count of clip proxy badges, and the
 * engine's own counters. Then it asserts the four claims of the notice commit against those samples:
 *
 *   A. The completion notice never claims success it did not have (counts must match the engine).
 *   B. The in-progress notice never says "softer" over a 4K source (the measured truth is frozen).
 *   C. A frozen canvas is never unexplained — a badge or the overlay is on screen saying "proxy not
 *      ready", so the reading available to the user is not "the app is broken".
 *   D. The copy tells the user that PLAYING PAUSES THE BUILDS, i.e. that waiting is the winning move.
 *      Without it the user's instinct (press play again, scrub) extends the very window that causes
 *      the freeze, which is the difference between a slow feature and a trap.
 *
 * Deliberately COLD (no proxy wait) and deliberately 4K: that is the only regime where all four
 * claims are load-bearing at once.
 *
 * Run:
 *   PROBE_4K_DIR=<dir> PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/debt033-notice-truth-probe.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { importAssets, reachEditor } from "./browser/editor-session.js";

const N = Number(process.env.PROBE_N ?? 3);
const CANVAS_SELECTOR = "canvas.preview-scene-canvas";
const SAMPLE_INTERVAL_MS = 500;
const PLAY_SAMPLES = 20; // 10s of playback while builds are pending
const DRAIN_TIMEOUT_MS = Number(process.env.PROBE_DRAIN_TIMEOUT_MS ?? 420_000);

interface Surface {
  toast: string | null;
  overlay: string | null;
  badges: { total: number; failed: number };
  proxy: { built: number; failed: number; skipped: number; queued: number; active: string | null } | null;
  drain: { total: number; built: number; failed: number; skipped: number } | null;
}

interface PlaySample extends Surface {
  t: number;
  hash: string;
  changed: boolean | null;
  clock: number | null;
}

let passed = 0;
let failedChecks = 0;
function check(label: string, condition: boolean, evidence?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${evidence ? ` — ${evidence}` : ""}`);
  } else {
    failedChecks += 1;
    console.log(`  FAIL  ${label}${evidence ? ` — ${evidence}` : ""}`);
  }
}

function clips(count: number): string[] {
  const dir = process.env.PROBE_4K_DIR;
  if (!dir) throw new Error("PROBE_4K_DIR must point at a directory of distinct 4K clips");
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".mp4")).map((n) => path.join(dir, n)).sort();
  if (files.length < count) throw new Error(`need ${count} clips, found ${files.length} in ${dir}`);
  return files.slice(0, count);
}

async function readSurfaces(page: Page): Promise<Surface> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __rfSourceProxy?: { built: number; failed: number; skipped: number; queued: number; active: string | null };
      __rfProxyDrainSummary?: { total: number; built: number; failed: number; skipped: number };
    };
    const toast = document.querySelector(".editor-toast");
    const overlay = document.querySelector(".preview-proxy-state");
    const badges = Array.from(document.querySelectorAll(".clip-proxy-badge"));
    return {
      toast: toast?.textContent?.trim() ?? null,
      overlay: overlay?.textContent?.trim() ?? null,
      badges: { total: badges.length, failed: badges.filter((b) => b.classList.contains("is-failed")).length },
      proxy: w.__rfSourceProxy ?? null,
      drain: w.__rfProxyDrainSummary ?? null,
    };
  });
}

async function addClipsToTimeline(page: Page, count: number): Promise<number> {
  let placed = 0;
  for (let i = 1; i < count; i++) {
    const tile = page.locator(".asset-tile").nth(i);
    if (!(await tile.count().catch(() => 0))) break;
    await tile.hover().catch(() => undefined);
    await page.waitForTimeout(150);
    const add = tile.locator('button[title="Add video only"]').first();
    if (!(await add.count().catch(() => 0))) break;
    await add.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    placed += 1;
  }
  return placed + 1;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "debt033-notice-truth-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");
  const all = clips(N);
  console.log(`media: ${N} distinct 4K clips from ${process.env.PROBE_4K_DIR}`);

  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  await reachEditor(page, { clipPath: all[0]!, flags: "wcDecode=1" });
  await page.waitForTimeout(3_000);
  if (N > 1) await importAssets(page, all.slice(1, N));
  const placed = await addClipsToTimeline(page, N);
  console.log(`placed on timeline: ${placed}/${N}`);
  if (placed < N) {
    console.log(`VOID — only ${placed}/${N} clips landed; a probe that cannot build the scene cannot report on it.`);
    await browser.close();
    process.exit(2);
  }

  // ---------------------------------------------------------------------------------------------
  // PHASE 1 — PARKED, builds running. What does the product say while it is not ready?
  // ---------------------------------------------------------------------------------------------
  console.log("\n## PHASE 1 — parked, builds in flight");
  const parked: Surface[] = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    const s = await readSurfaces(page);
    parked.push(s);
    console.log(
      `  t=${((i + 1) * SAMPLE_INTERVAL_MS) / 1000}s badges=${s.badges.total}(${s.badges.failed} failed) proxy=${JSON.stringify(s.proxy)}\n        toast: ${s.toast ?? "-"}`
    );
  }

  const buildingSamples = parked.filter((s) => s.proxy != null && (s.proxy.queued > 0 || s.proxy.active !== null));
  const toastsWhileBuilding = buildingSamples.map((s) => s.toast).filter((t): t is string => Boolean(t));
  console.log(`\n  samples with a build in flight: ${buildingSamples.length}/${parked.length}`);

  if (buildingSamples.length === 0) {
    console.log("  VOID for the in-progress claims — no build was in flight during phase 1.");
  } else {
    check(
      "B: no in-progress notice describes 4K playback as merely 'softer'",
      !toastsWhileBuilding.some((t) => /softer/i.test(t)),
      toastsWhileBuilding.find((t) => /softer/i.test(t)) ?? `${toastsWhileBuilding.length} toasts seen`
    );
    const optimizing = toastsWhileBuilding.filter((t) => /Optimizing/i.test(t));
    check(
      "D: the in-progress notice says playing pauses optimizing",
      optimizing.length > 0 && optimizing.every((t) => /Playing pauses optimizing/i.test(t)),
      optimizing[0] ?? "no 'Optimizing' toast observed"
    );
    check(
      "A: no completion notice fires while builds are still in flight",
      !toastsWhileBuilding.some((t) => /finished/i.test(t)),
      toastsWhileBuilding.find((t) => /finished/i.test(t)) ?? "none"
    );
    check(
      "C: pending proxies are visible on the timeline as clip badges",
      buildingSamples.some((s) => s.badges.total > 0),
      `max badges observed: ${Math.max(...buildingSamples.map((s) => s.badges.total))}`
    );
  }

  // ---------------------------------------------------------------------------------------------
  // PHASE 2 — PLAY while builds are pending. Correlate the canvas with what is on screen.
  // ---------------------------------------------------------------------------------------------
  console.log("\n## PHASE 2 — playing 4K originals while proxies are pending (the trap regime)");
  const canvas = page.locator(CANVAS_SELECTOR).first();
  if (!(await canvas.count().catch(() => 0))) {
    console.log(`VOID — no ${CANVAS_SELECTOR}; cannot measure where the user looks.`);
    await browser.close();
    process.exit(2);
  }
  await page.keyboard.press("Home").catch(() => undefined);
  await page.waitForTimeout(300);
  await page.keyboard.press("Space").catch(() => undefined);

  const play: PlaySample[] = [];
  let prevHash: string | null = null;
  for (let i = 0; i < PLAY_SAMPLES; i++) {
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    const shot = await canvas.screenshot({ timeout: 5_000 }).catch(() => null);
    const hash = shot ? crypto.createHash("sha1").update(shot).digest("hex").slice(0, 12) : "SHOTFAIL";
    const s = await readSurfaces(page);
    const clock = await page.evaluate(() => {
      const w = window as unknown as { __rfClock?: { committed?: number } };
      return w.__rfClock?.committed ?? null;
    });
    play.push({ ...s, t: ((i + 1) * SAMPLE_INTERVAL_MS) / 1000, hash, changed: prevHash === null ? null : hash !== prevHash, clock });
    prevHash = hash;
    console.log(
      `  t=${play[i]!.t.toFixed(1)}s canvas=${play[i]!.changed === null ? "----" : play[i]!.changed ? "CHANGED" : "SAME   "}` +
        ` clock=${clock == null ? "?" : clock.toFixed(2)} badges=${s.badges.total} overlay=${s.overlay ? "YES" : "no"}`
    );
  }
  await page.keyboard.press("Space").catch(() => undefined);

  const comparable = play.filter((s) => s.changed !== null);
  const frozen = comparable.filter((s) => s.changed === false);
  const clocks = play.map((s) => s.clock).filter((c): c is number => c != null);
  const clockAdvanced = clocks.length >= 2 ? clocks[clocks.length - 1]! - clocks[0]! : 0;
  console.log(
    `\n  canvas changed ${comparable.filter((s) => s.changed).length}/${comparable.length} samples; clock advanced ${clockAdvanced.toFixed(2)}s`
  );
  if (frozen.length === 0) {
    console.log("  (canvas never repeated a frame in this window — claim C has nothing to bind to here, reported as such)");
  } else {
    check(
      "C: every frozen-canvas sample carries an on-screen explanation (overlay or clip badge)",
      frozen.every((s) => s.overlay !== null || s.badges.total > 0),
      `${frozen.filter((s) => s.overlay !== null || s.badges.total > 0).length}/${frozen.length} explained`
    );
    check(
      "A: no sample claims optimization finished while the canvas is frozen and builds are pending",
      !frozen.some((s) => /finished/i.test(s.toast ?? "") && s.proxy != null && (s.proxy.queued > 0 || s.proxy.active !== null)),
      frozen.find((s) => /finished/i.test(s.toast ?? ""))?.toast ?? "none"
    );
    const overlays = frozen.map((s) => s.overlay).filter((o): o is string => Boolean(o));
    if (overlays.length > 0) {
      check(
        "D: the preview overlay tells the user that playing pauses the build",
        overlays.every((o) => /Playing pauses the (build|queue)/i.test(o)),
        overlays[0]!
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // PHASE 3 — drain. The completion notice against the engine's own counts.
  // ---------------------------------------------------------------------------------------------
  console.log("\n## PHASE 3 — waiting for the queue to drain (transport parked, so builds run)");
  const start = Date.now();
  let final: Surface | null = null;
  let idleStreak = 0;
  while (Date.now() - start < DRAIN_TIMEOUT_MS) {
    await page.waitForTimeout(2_000);
    const s = await readSurfaces(page);
    const idle = s.proxy != null && s.proxy.queued === 0 && s.proxy.active === null;
    idleStreak = idle ? idleStreak + 1 : 0;
    if (idleStreak >= 3) {
      final = s;
      break;
    }
  }
  if (!final) {
    console.log(`  VOID for the completion claims — the queue never went idle within ${DRAIN_TIMEOUT_MS}ms.`);
  } else {
    console.log(`  engine: ${JSON.stringify(final.proxy)}`);
    console.log(`  drain summary: ${JSON.stringify(final.drain)}`);
    console.log(`  final toast: ${final.toast ?? "-"}`);
    console.log(`  badges left: ${final.badges.total} (${final.badges.failed} failed)`);
    const toast = final.toast ?? "";
    const drain = final.drain;
    if (!/optimization/i.test(toast)) {
      console.log("  the completion toast was not on screen at read time — reported, not asserted.");
    } else if (drain) {
      check(
        "A: the completion notice's built count matches the engine's",
        new RegExp(`(all ${drain.total} optimized|${drain.built} of ${drain.total} optimized)`).test(toast),
        toast
      );
      check(
        "A: the completion notice reports failures when there were failures",
        drain.failed === 0 ? !/failed/i.test(toast) : /failed/i.test(toast),
        `drain.failed=${drain.failed} — "${toast}"`
      );
      check(
        "A: 'all optimized' appears only when everything was optimized",
        !/all \d+ optimized/.test(toast) || drain.built === drain.total,
        toast
      );
    }
  }

  await browser.close();
  console.log(`\ndebt033-notice-truth-probe: ${passed} passed, ${failedChecks} failed`);
  if (failedChecks > 0) process.exit(1);
}

void main();
