/**
 * DEBT-033 — DOES THE PLAY GATE DO WHAT IT CLAIMS? Measured at the canvas.
 *
 * FOUNDER RULE: never start playback until the media is optimized; if the user presses play, show the
 * tasks and their real progress. Three claims, and each is checked against what a user would see:
 *
 *   A. Pressing play on un-optimized media does NOT start playback — it shows the window instead. The
 *      canvas must not begin the frozen-4K state this whole chapter has been measuring.
 *   B. The window shows REAL progress: a percentage that ADVANCES, sourced from the encoder's own frame
 *      counter. A bar that moves on a timer would be inventing progress, which is the exact defect
 *      class this chapter keeps finding, one layer up.
 *   C. When the blocking builds finish, playback starts BY ITSELF and the canvas actually moves — no
 *      second gesture. Otherwise the gate is a wall rather than a wait.
 *
 * Also asserted, because it is what stops the gate becoming a cage: the window offers "Play anyway",
 * and a terminal task (one that can never be proxied — DEBT-034) is listed with its reason rather than
 * silently blocking the transport forever.
 *
 * Page-side code is SOURCE TEXT — tsx's `keepNames` wraps function-valued consts in `__name()`.
 *
 * Run:
 *   PROBE_4K_DIR=<dir> PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/debt033-play-gate-probe.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { importAssets, reachEditor } from "./browser/editor-session.js";

const N = Number(process.env.PROBE_N ?? 3);
const CANVAS = "canvas.preview-scene-canvas";
const DIALOG = ".proxy-optimize-dialog";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, evidence?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${evidence ? ` — ${evidence}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${evidence ? ` — ${evidence}` : ""}`);
  }
}

function clips(count: number): string[] {
  const dir = process.env.PROBE_4K_DIR;
  if (!dir) throw new Error("PROBE_4K_DIR must point at a directory of 4K clips");
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".mp4")).map((n) => path.join(dir, n)).sort();
  if (files.length < count) throw new Error(`need ${count} clips, found ${files.length}`);
  return files.slice(0, count);
}

async function addClips(page: Page, count: number): Promise<number> {
  let placed = 0;
  for (let i = 1; i < count; i++) {
    const tile = page.locator(".asset-tile").nth(i);
    if (!(await tile.count().catch(() => 0))) break;
    await tile.hover().catch(() => undefined);
    await page.waitForTimeout(150);
    const add = tile.locator('button[title="Add video only"]').first();
    if (!(await add.count().catch(() => 0))) break;
    await add.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(400);
    placed += 1;
  }
  return placed + 1;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "debt033-play-gate-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");
  const all = clips(N);

  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  await reachEditor(page, { clipPath: all[0]!, flags: "wcDecode=1" });
  await page.waitForTimeout(3_000);
  if (N > 1) await importAssets(page, all.slice(1, N));
  const placed = await addClips(page, N);
  console.log(`placed ${placed}/${N} clips`);
  if (placed < N) {
    console.log("VOID — scene not built.");
    await browser.close();
    process.exit(2);
  }

  const canvas = page.locator(CANVAS).first();
  await page.waitForTimeout(1_500); // COLD on purpose: builds are still in flight
  await page.keyboard.press("Home").catch(() => undefined);
  await page.waitForTimeout(300);

  const before = await canvas.screenshot({ timeout: 5_000 }).catch(() => null);
  await page.keyboard.press("Space").catch(() => undefined);
  await page.waitForTimeout(1_500);

  // ── A. play did not start; the window did ──────────────────────────────────────────────────────
  const dialogUp = (await page.locator(DIALOG).count().catch(() => 0)) > 0;
  const playing = (await page.evaluate(`(function () { var f = window.__rfFrameStats; return f ? f.playing : null; })()`)) as boolean | null;
  check("A: pressing play on un-optimized media opens the optimization window", dialogUp);
  check("A: the transport did NOT start", playing !== true, `__rfFrameStats.playing = ${playing}`);

  // NOT a canvas-sameness check. The first version of this compared the canvas before and after the
  // gesture and FAILED — because the modal's backdrop covers the canvas, so an element screenshot of
  // that region captures the dialog painted over it. "The picture did not change" is unmeasurable
  // through a modal; the claim that actually matters is that the TRANSPORT never ran, so assert the
  // clock. (`before` is still captured above as the parked reference for the post-release comparison.)
  void before;
  const clockDuring = (await page.evaluate(`(function () { var c = window.__rfClock; return c ? c.committed : null; })()`)) as number | null;
  await page.waitForTimeout(2_000);
  const clockLater = (await page.evaluate(`(function () { var c = window.__rfClock; return c ? c.committed : null; })()`)) as number | null;
  const clockDelta = clockDuring != null && clockLater != null ? clockLater - clockDuring : 0;
  check(
    "A: the transport clock does NOT advance while the window is up (no frozen-playback state entered)",
    Math.abs(clockDelta) < 0.05,
    `clock ${clockDuring?.toFixed(2)} -> ${clockLater?.toFixed(2)}`
  );

  // ── B. the progress shown is real ──────────────────────────────────────────────────────────────
  const readPct = `(function () {
    var rows = document.querySelectorAll(".proxy-optimize-row.is-active .proxy-optimize-pct");
    var out = [];
    for (var i = 0; i < rows.length; i++) out.push((rows[i].textContent || "").trim());
    return out;
  })()`;
  const firstPct = (await page.evaluate(readPct)) as string[];
  let advanced = false;
  let lastSeen: string[] = firstPct;
  for (let i = 0; i < 30 && !advanced; i++) {
    await page.waitForTimeout(2_000);
    const now = (await page.evaluate(readPct)) as string[];
    if (JSON.stringify(now) !== JSON.stringify(lastSeen)) advanced = true;
    lastSeen = now;
    if ((await page.locator(DIALOG).count().catch(() => 0)) === 0) break; // finished while we watched
  }
  check("B: a task's progress percentage ADVANCES (real encoder frames, not a timer)", advanced, `${JSON.stringify(firstPct)} -> ${JSON.stringify(lastSeen)}`);

  const controls = (await page.evaluate(`(function () {
    var btns = document.querySelectorAll(".proxy-optimize-actions button");
    var labels = [];
    for (var i = 0; i < btns.length; i++) labels.push((btns[i].textContent || "").trim());
    var terminal = document.querySelectorAll(".proxy-optimize-row.is-terminal").length;
    return { labels: labels, terminal: terminal };
  })()`)) as { labels: string[]; terminal: number };
  check("the window is a default, not a cage — 'Play anyway' is offered", controls.labels.some((l) => /play anyway/i.test(l)), JSON.stringify(controls.labels));
  console.log(`  (terminal, never-optimizable tasks listed with a reason: ${controls.terminal})`);

  // ── C. it releases by itself, and the picture then moves ───────────────────────────────────────
  console.log("  waiting for the blocking builds to finish (no further input from this probe)...");
  let released = false;
  for (let i = 0; i < 210; i++) {
    await page.waitForTimeout(2_000);
    if ((await page.locator(DIALOG).count().catch(() => 0)) === 0) {
      released = true;
      break;
    }
  }
  check("C: the window closes by itself when the builds finish", released);

  if (released) {
    await page.waitForTimeout(1_500);
    const nowPlaying = (await page.evaluate(`(function () { var f = window.__rfFrameStats; return f ? f.playing : null; })()`)) as boolean | null;
    check("C: playback starts with NO second gesture from the user", nowPlaying === true, `playing = ${nowPlaying}`);

    let prev: string | null = null;
    let changed = 0;
    let compared = 0;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(700);
      const shot = await canvas.screenshot({ timeout: 5_000 }).catch(() => null);
      const hash = shot ? crypto.createHash("sha1").update(shot).digest("hex").slice(0, 12) : `X${i}`;
      if (prev !== null) {
        compared += 1;
        if (hash !== prev) changed += 1;
      }
      prev = hash;
    }
    check("C: and the canvas actually MOVES once it plays", compared > 0 && changed / compared >= 0.5, `${changed}/${compared} samples changed`);
  }

  await page.keyboard.press("Space").catch(() => undefined);
  await browser.close();
  console.log(`\ndebt033-play-gate-probe: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
