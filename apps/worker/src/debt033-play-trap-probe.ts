/**
 * DEBT-033 — DOES THE PLAY/PAUSE TRAP ACTUALLY BREAK? Measured at the canvas, never paused.
 *
 * THE TRAP. Ingest-proxy builds suspend while the transport plays (the 2026-07-06 "plays ~4s then
 * freezes" scar). On a cold 4K timeline the preview is frozen 100% of the time, so pressing play
 * suspends the only work that will end the freeze — and the user's instinct, press play again and
 * scrub, extends the exact window causing it. `playbackLiveness.ts` now releases the gate when
 * playback is running and delivering NOTHING, on the argument that there is no smooth playback left to
 * protect in that state.
 *
 * THE TEST IS THE USER'S OWN WORST BEHAVIOUR: press play on cold 4K and NEVER PAUSE. Then ask the only
 * question that matters, at the canvas:
 *
 *   Does the picture come back WITHOUT the user pausing?
 *
 * Under the old rule the answer is no by construction — builds are suspended for as long as the
 * transport runs, so the proxies never land and the freeze is permanent. A PASS therefore cannot be
 * explained by "we waited longer"; it can only come from builds progressing during playback.
 *
 * Also recorded, because the fix must not be a blunt instrument: `__rfPlaybackStalled` (did the narrow
 * condition actually fire, or did something else change?) and the proxy engine's own build counter (is
 * work really progressing while playing?).
 *
 * Run:
 *   PROBE_4K_DIR=<dir> PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/debt033-play-trap-probe.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { importAssets, reachEditor } from "./browser/editor-session.js";

const N = Number(process.env.PROBE_N ?? 3);
const CANVAS_SELECTOR = "canvas.preview-scene-canvas";
const SAMPLE_MS = 2_000;
const MAX_SAMPLES = Number(process.env.PROBE_SAMPLES ?? 120); // up to 4 minutes of continuous playback

function clips(count: number): string[] {
  const dir = process.env.PROBE_4K_DIR;
  if (!dir) throw new Error("PROBE_4K_DIR must point at a directory of distinct 4K clips");
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".mp4")).map((n) => path.join(dir, n)).sort();
  if (files.length < count) throw new Error(`need ${count} clips, found ${files.length}`);
  return files.slice(0, count);
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
  assertQuietBrowserMachine({ label: "debt033-play-trap-probe" });
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
  const placed = await addClipsToTimeline(page, N);
  console.log(`placed on timeline: ${placed}/${N}`);
  if (placed < N) {
    console.log(`VOID — only ${placed}/${N} clips landed.`);
    await browser.close();
    process.exit(2);
  }

  const canvas = page.locator(CANVAS_SELECTOR).first();
  if (!(await canvas.count().catch(() => 0))) {
    console.log(`VOID — no ${CANVAS_SELECTOR}.`);
    await browser.close();
    process.exit(2);
  }

  // COLD: straight to play, no proxy wait. And from here the transport is NEVER paused.
  await page.waitForTimeout(2_000);
  await page.keyboard.press("Home").catch(() => undefined);
  await page.waitForTimeout(300);
  await page.keyboard.press("Space").catch(() => undefined);
  console.log("playing — the transport is not paused again for the rest of this run\n");

  let prevHash: string | null = null;
  let firstStalledAt: number | null = null;
  let firstBuildWhilePlayingAt: number | null = null;
  let firstRecoveryAt: number | null = null;
  let builtAtPlayStart: number | null = null;
  let liveStreak = 0;
  let firstProgressWhilePlayingAt: number | null = null;
  let lastProgressWhilePlaying: number | null = null;

  for (let i = 0; i < MAX_SAMPLES; i++) {
    await page.waitForTimeout(SAMPLE_MS);
    const t = ((i + 1) * SAMPLE_MS) / 1000;
    const shot = await canvas.screenshot({ timeout: 5_000 }).catch(() => null);
    const hash = shot ? crypto.createHash("sha1").update(shot).digest("hex").slice(0, 12) : "SHOTFAIL";
    const changed = prevHash === null ? null : hash !== prevHash;
    prevHash = hash;

    const state = (await page.evaluate(`(function () {
      var w = window;
      var p = w.__rfSourceProxy || null;
      var f = w.__rfFrameStats || null;
      return {
        built: p ? p.built : null,
        progressFrames: p ? (p.progressFrames || 0) : null,
        queued: p ? p.queued : null,
        active: p ? !!p.active : null,
        stalled: w.__rfPlaybackStalled ? w.__rfPlaybackStalled.stalled : null,
        playing: f ? f.playing : null,
        minMediaFps: f ? f.minMediaFps : null,
        fps: f ? f.fps : null,
        clock: w.__rfClock ? w.__rfClock.committed : null
      };
    })()`)) as {
      built: number | null;
      progressFrames: number | null;
      queued: number | null;
      active: boolean | null;
      stalled: boolean | null;
      playing: boolean | null;
      minMediaFps: number | null;
      fps: number | null;
      clock: number | null;
    };

    if (builtAtPlayStart === null) builtAtPlayStart = state.built ?? 0;
    // PROGRESS, not completion, is the signal for "are builds running during playback?" — a 4K build
    // outlasts any window a probe can hold playback open for, so waiting for `built` to move proved
    // nothing twice. `progressFrames` advances continuously inside a build.
    if (state.playing === true && state.progressFrames != null) {
      if (lastProgressWhilePlaying != null && state.progressFrames > lastProgressWhilePlaying && firstProgressWhilePlayingAt === null) {
        firstProgressWhilePlayingAt = t;
      }
      lastProgressWhilePlaying = state.progressFrames;
    }
    if (state.stalled === true && firstStalledAt === null) firstStalledAt = t;
    // `state.playing` IS PART OF THE CONDITION, and the first version of this probe omitted it and
    // produced a false PASS: with 20s clips the composition ENDED at ~21s, `playing` went false, and
    // the build that completed at 36s did so with the transport stopped — which says nothing at all
    // about whether builds run DURING playback. A build only counts here if playback was live when it
    // landed, and the clips are now long enough (120s) to outlast a 4K build.
    if (
      firstBuildWhilePlayingAt === null &&
      state.playing === true &&
      state.built != null &&
      builtAtPlayStart != null &&
      state.built > builtAtPlayStart
    ) {
      firstBuildWhilePlayingAt = t;
    }
    if (changed === true && state.playing === true) {
      liveStreak += 1;
      if (liveStreak >= 3 && firstRecoveryAt === null) firstRecoveryAt = t; // sustained motion, not one blip
    } else if (changed === false) {
      liveStreak = 0;
    }

    console.log(
      `  t=${String(t).padStart(5)}s canvas=${changed === null ? "----" : changed ? "CHANGED" : "SAME   "}` +
        ` stalled=${state.stalled} playing=${state.playing} minMedia=${state.minMediaFps == null ? "null" : state.minMediaFps.toFixed(1)}` +
        ` built=${state.built} prog=${state.progressFrames} queued=${state.queued} active=${state.active} clock=${state.clock == null ? "?" : state.clock.toFixed(1)}`
    );

    if (firstRecoveryAt !== null && state.queued === 0 && state.active === false) break;
  }

  const stillPlaying = await page.evaluate(`(function () { var f = window.__rfFrameStats; return f ? f.playing : null; })()`);
  await page.keyboard.press("Space").catch(() => undefined);
  await browser.close();

  console.log(`\n=== VERDICT ===`);
  console.log(`  transport still playing at the end (never paused by this probe): ${stillPlaying}`);
  if (stillPlaying !== true) console.log(`  ⚠ playback had STOPPED by the end — check the rows: a verdict drawn from samples where playing=false says nothing about the trap.`);
  console.log(`  stall condition first fired at:            ${firstStalledAt === null ? "NEVER" : firstStalledAt + "s"}`);
  console.log(`  build PROGRESSED while playing:           ${firstProgressWhilePlayingAt === null ? "NEVER" : "yes, first at " + firstProgressWhilePlayingAt + "s"}`);
  console.log(`  first proxy COMPLETED while playing:      ${firstBuildWhilePlayingAt === null ? "NEVER (a 4K build can outlast this window — not itself a failure)" : firstBuildWhilePlayingAt + "s"}`);
  console.log(`  canvas first sustained motion:             ${firstRecoveryAt === null ? "NEVER" : firstRecoveryAt + "s"}`);
  if (firstStalledAt === null) {
    console.log(`  INCONCLUSIVE — the stalled condition never fired, so the exception under test was never exercised.`);
  } else if (firstProgressWhilePlayingAt !== null) {
    console.log(`  PASS — the build ADVANCED while the transport was playing and stalled. Under the old rule it would`);
    console.log(`         have been parked for the whole of playback, so this cannot be explained by waiting longer.`);
    if (firstBuildWhilePlayingAt !== null && firstRecoveryAt !== null) {
      console.log(`         Stronger still: a proxy COMPLETED and the picture returned, with no pause.`);
    }
  } else {
    console.log(`  FAIL — playback stalled but no build advanced during it; the trap is intact.`);
  }
}

void main();
