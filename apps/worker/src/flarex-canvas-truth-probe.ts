/**
 * DEBT-033 — THE GROUND-TRUTH INSTRUMENT: measure the CANVAS, not the pipeline.
 *
 * WHY THIS EXISTS, and why it outranks every other measurement in this chapter. The founder, on being
 * shown healthy delivery numbers over a frozen preview: *"I don't know how you are recording the fps,
 * maybe that's playing somewhere else but not at the previewer panel."* Taken literally, the mechanism
 * is available and it invalidates our instrument:
 *
 *   `mediaFps`/`minMediaFps` count `requestVideoFrameCallback` ticks on the `<video>` ELEMENTS. A video
 *   element presenting a frame and that frame REACHING THE PREVIEW CANVAS are two separate events. If
 *   the compositor stops drawing those elements into the canvas at high layer counts, the videos keep
 *   decoding and presenting — rVFC keeps firing, the numbers stay healthy — while the preview is frozen.
 *
 * That is consistent with every observation this chapter could not explain: healthy numbers over a
 * frozen picture, nothing playing at N=11, and the repeated failure to reproduce it with instruments
 * that count at the SOURCE rather than at the SCREEN. The per-layer-minimum fix shipped earlier was
 * correct and does not reach this: it made the count honest about WHICH layer, but it still counts the
 * wrong event.
 *
 * THE LESSON, which belongs above any individual fix: this is the FOURTH instrument gap in this chapter,
 * and every one of them counted the system's INTERNAL ACTIVITY rather than WHAT REACHED THE USER.
 * (1) `mediaFps` summed across layers so a collapse read as healthy. (2) `fps` is the compositor's
 * repaint rate and happily redraws an unchanged frame. (3) `__rfWcMode` is keyed by URL and undercounts
 * shared sources. (4) this one — delivery counted at the decoder, never at the canvas.
 *
 * HOW IT MEASURES. Screenshots the actual preview canvas element (`canvas.preview-scene-canvas`) at 2Hz
 * during playback and hashes the bytes. Identical hash across successive samples WHILE THE CLOCK IS
 * ADVANCING and `mediaFps` reads above zero is a frozen preview, measured at the screen. Deliberately
 * NOT an in-page `getImageData` readback: a WebGL canvas without `preserveDrawingBuffer` reads back
 * blank after compositing (the readback would report "black" and a black frame never changes — the
 * instrument would manufacture a freeze), and this chapter already measured a full readback at 21-26ms
 * per layer. The screenshot path goes through the browser's own compositor, costs nothing on the
 * production frame path, and is a strictly better answer to "what reached the screen".
 *
 * Two outcomes, both worth reporting loudly:
 *   - canvas STOPS changing while mediaFps stays positive → the defect is named, and it is a COMPOSITOR
 *     question, not a decoder one.
 *   - canvas DOES change while the founder reports frozen → the gap is between our canvas and their
 *     screen (presentation/compositing/something outside the page), which is a different and stranger
 *     problem.
 *
 * CONDITIONS — the founder's, reproduced: real Pexels 4K footage, N = 1/3/5/6/11 (their cliff is at
 * FIVE, so the ladder brackets it), COLD (no proxy wait) by default. `PROBE_WARM=1` waits for the ingest
 * proxies instead — the "does the product already solve this?" arm, since proxies exist precisely so
 * that many layers do not each decode full-resolution media. `PROBE_N_LADDER` overrides the ladder.
 *
 * MEDIA. `PROBE_4K_DIR` must hold >= max(N) distinct clips. The committed run used 11 distinct 20s
 * segments cut (stream-copy, no re-encode) from the one true-4K Pexels asset in local storage,
 * `13271143_2160_3840_30fps.mp4` — **2160x3840 vertical 4K, 30fps**. Distinct FILES, so distinct blob
 * URLs and asset ids, so no decoder-session sharing (the confound that voided an earlier attempt); the
 * shared origin means content is near-identical across layers, which is stated rather than hidden.
 * Every clip is 20s so it outlasts the sample window — the confound that voided the first cold-delivery
 * run, where clips ENDED mid-window and read as `minMediaFps 0.0` exactly like a stall.
 *
 * Run:
 *   PROBE_4K_DIR=<dir> PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-canvas-truth-probe.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { importAssets, reachEditor } from "./browser/editor-session.js";

const N_LADDER = (process.env.PROBE_N_LADDER ?? "1,3,5,6,11").split(",").map((s) => Number(s.trim()));
const COLD_WAIT_MS = 2_000;
/**
 * WARM mode (`PROBE_WARM=1`): every ingest proxy BUILT AND VERIFIED before playback, not merely waited
 * on. Proxies exist so that many layers do not each decode full-resolution media, and a 4K source is
 * exactly what they are for — so "does the product already solve this?" is a one-run question, and it
 * decides how large the rest of the problem is. Verification is `queued === 0 && active === null` AND
 * every asset accounted for as built-or-skipped, not a bare idle reading (an engine that has not yet
 * NOTICED the new assets also reads idle — the trap an earlier probe hit and had to guard against).
 */
const WARM = process.env.PROBE_WARM === "1";
const PROXY_WAIT_TIMEOUT_MS = Number(process.env.PROBE_PROXY_TIMEOUT_MS ?? 300_000);
const SAMPLE_COUNT = 24;
const SAMPLE_INTERVAL_MS = 500; // 2Hz
const CANVAS_SELECTOR = "canvas.preview-scene-canvas";

interface Sample {
  t: number;
  hash: string;
  changed: boolean | null;
  clock: number | null;
  fps: number;
  minMediaFps: number | null;
  mediaFps: number;
  activeMediaLayers: number;
  droppedRatio: number;
  videoActive: number | null;
}

function clips4k(count: number): string[] {
  const dir = process.env.PROBE_4K_DIR;
  if (!dir) throw new Error("PROBE_4K_DIR must point at a directory of distinct 4K clips");
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".mp4"))
    .map((n) => path.join(dir, n))
    .sort();
  if (files.length < count) throw new Error(`need ${count} distinct 4K clips, found ${files.length} in ${dir}`);
  return files.slice(0, count);
}

async function addClipsToTimeline(page: Page, count: number): Promise<number> {
  let placed = 0;
  for (let i = 1; i < count; i++) {
    const tile = page.locator(".asset-tile").nth(i);
    if (!(await tile.count().catch(() => 0))) break;
    await tile.hover().catch(() => undefined);
    await page.waitForTimeout(150);
    const addVideoBtn = tile.locator('button[title="Add video only"]').first();
    if (!(await addVideoBtn.count().catch(() => 0))) break;
    await addVideoBtn.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    placed += 1;
  }
  return placed + 1;
}

async function runArm(channel: string | undefined, n: number, allClips: string[]) {
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  // Seed with a 4K clip too, so EVERY layer in every arm is 4K (the founder's condition).
  await reachEditor(page, { clipPath: allClips[0]!, flags: "wcDecode=1" });
  await page.waitForTimeout(3_000);

  if (n > 1) await importAssets(page, allClips.slice(1, n));
  const placed = await addClipsToTimeline(page, n);
  console.log(`  placed on timeline: ${placed}/${n}`);
  if (placed < n) {
    console.log(`  ⚠ VOID for N=${n} — only ${placed}/${n} clips landed.`);
    await browser.close();
    return null;
  }

  let proxyAtPlay: unknown = null;
  let proxyVerified = false;
  let idleStreak = 0;
  if (WARM) {
    const start = Date.now();
    let poll = 0;
    while (Date.now() - start < PROXY_WAIT_TIMEOUT_MS) {
      const snap = await page.evaluate(() => {
        const w = window as unknown as {
          __rfSourceProxy?: { built: number; failed: number; skipped: number; queued: number; active: unknown };
        };
        return w.__rfSourceProxy ?? null;
      });
      proxyAtPlay = snap;
      poll += 1;
      // Idle = queue drained AND nothing building. Require it STABLE across consecutive polls: a single
      // idle reading also describes an engine that has not yet noticed the new assets.
      //
      // Deliberately NOT "built >= n". The first warm run demanded that and voided every arm above N=1,
      // which was the CRITERION failing, not the app: the engine had genuinely finished, and some assets
      // are legitimately never proxied — the N=11 arm reported 4 of 11 `skipped: "no local bytes"`, a
      // terminal outcome no amount of waiting changes. `built`/`skipped` are reported per arm instead,
      // so "warm" is qualified by evidence rather than asserted by a threshold.
      const idle = snap != null && snap.queued === 0 && snap.active === null;
      idleStreak = idle ? idleStreak + 1 : 0;
      if (poll >= 3 && idleStreak >= 3) {
        proxyVerified = true;
        break;
      }
      await page.waitForTimeout(2_000);
    }
    console.log(`  [warm] proxies verified: ${proxyVerified} — ${JSON.stringify(proxyAtPlay)}`);
    if (!proxyVerified) {
      console.log(`  ⚠ VOID for N=${n} — proxies never reached built-and-idle for all ${n} assets within ${PROXY_WAIT_TIMEOUT_MS}ms.`);
      await browser.close();
      return null;
    }
  } else {
    // COLD: no proxy wait. Record what the engine was still doing, to prove the arm really was cold.
    await page.waitForTimeout(COLD_WAIT_MS);
    proxyAtPlay = await page.evaluate(() => {
      const w = window as unknown as { __rfSourceProxy?: unknown };
      return w.__rfSourceProxy ?? null;
    });
  }

  const canvas = page.locator(CANVAS_SELECTOR).first();
  if (!(await canvas.count().catch(() => 0))) {
    console.log(`  ⚠ VOID for N=${n} — no ${CANVAS_SELECTOR} found. A probe that cannot see the canvas cannot report on it.`);
    await browser.close();
    return null;
  }

  await page.keyboard.press("Home").catch(() => undefined);
  await page.waitForTimeout(300);
  await page.keyboard.press("Space").catch(() => undefined);

  const samples: Sample[] = [];
  let prevHash: string | null = null;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    const shot = await canvas.screenshot({ timeout: 5_000 }).catch(() => null);
    const hash = shot ? crypto.createHash("sha1").update(shot).digest("hex").slice(0, 12) : "SHOTFAIL";
    const stats = await page.evaluate(() => {
      const w = window as unknown as {
        __rfFrameStats?: {
          fps: number;
          minMediaFps: number | null;
          mediaFps: number;
          activeMediaLayers: number;
          droppedRatio: number;
        };
        __rfClock?: { committed?: number };
        __rfVideoPoolStats?: { active?: number };
      };
      const f = w.__rfFrameStats;
      return {
        clock: w.__rfClock?.committed ?? null,
        videoActive: w.__rfVideoPoolStats?.active ?? null,
        fps: f?.fps ?? 0,
        minMediaFps: f?.minMediaFps ?? null,
        mediaFps: f?.mediaFps ?? 0,
        activeMediaLayers: f?.activeMediaLayers ?? 0,
        droppedRatio: f?.droppedRatio ?? 0,
      };
    });
    samples.push({ t: (i + 1) * (SAMPLE_INTERVAL_MS / 1000), hash, changed: prevHash === null ? null : hash !== prevHash, ...stats });
    prevHash = hash;
  }

  const wcPool = await page.evaluate(() => {
    const w = window as unknown as { __rfWcPool?: { capMisses?: number; admissionDenials?: number } };
    return { capMisses: w.__rfWcPool?.capMisses ?? null, admissionDenials: w.__rfWcPool?.admissionDenials ?? null };
  });

  await page.keyboard.press("Space").catch(() => undefined);
  await browser.close();
  return { samples, wcPool, proxyAtPlay, proxyVerified };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex-canvas-truth-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");

  const allClips = clips4k(Math.max(...N_LADDER));
  console.log(`media: ${allClips.length} distinct 4K clips from ${process.env.PROBE_4K_DIR}`);

  const results: Record<number, Awaited<ReturnType<typeof runArm>>> = {};
  for (const n of N_LADDER) {
    console.log(`\n########## ${WARM ? "WARM" : "COLD"} 4K N=${n} ##########`);
    const r = await runArm(channel, n, allClips);
    results[n] = r;
    if (!r) continue;
    for (const s of r.samples) {
      console.log(
        `    t=${s.t.toFixed(1)}s canvas=${s.changed === null ? "----" : s.changed ? "CHANGED" : "SAME   "}` +
          ` clock=${s.clock == null ? "?" : s.clock.toFixed(2)} fps=${s.fps.toFixed(1)}` +
          ` minMedia=${s.minMediaFps == null ? "null" : s.minMediaFps.toFixed(1)} mediaSum=${s.mediaFps.toFixed(1)}` +
          ` layers=${s.activeMediaLayers} dropped=${(s.droppedRatio * 100).toFixed(0)}% vidActive=${s.videoActive}`
      );
    }
    console.log(`    proxy at play: ${JSON.stringify(r.proxyAtPlay)}`);
    console.log(`    wcPool: ${JSON.stringify(r.wcPool)}`);
  }

  console.log("\n\n=== SUMMARY: does the CANVAS change? (ground truth) ===");
  console.log("  N   canvasChanged/total  clockAdvanced  fps(med)  minMediaFps(med)  mediaSum(med)  dropped(med)  capMisses");
  for (const n of N_LADDER) {
    const r = results[n];
    if (!r) {
      console.log(`  ${n}: VOID`);
      continue;
    }
    const cmp = r.samples.filter((s) => s.changed !== null);
    const changed = cmp.filter((s) => s.changed === true).length;
    const clocks = r.samples.map((s) => s.clock).filter((c): c is number => c != null);
    const clockAdvanced = clocks.length >= 2 ? (clocks[clocks.length - 1]! - clocks[0]!).toFixed(2) + "s" : "?";
    const mins = r.samples.map((s) => s.minMediaFps).filter((v): v is number => v != null);
    console.log(
      `  ${String(n).padEnd(3)} ${`${changed}/${cmp.length}`.padEnd(20)}` +
        ` ${clockAdvanced.padEnd(14)}` +
        ` ${median(r.samples.map((s) => s.fps)).toFixed(1).padEnd(9)}` +
        ` ${(mins.length ? median(mins).toFixed(1) : "n/a").padEnd(17)}` +
        ` ${median(r.samples.map((s) => s.mediaFps)).toFixed(1).padEnd(14)}` +
        ` ${(median(r.samples.map((s) => s.droppedRatio)) * 100).toFixed(0).padEnd(13)}%` +
        ` ${r.wcPool.capMisses}`
    );
  }
  console.log("\nflarex-canvas-truth-probe: complete (measurement only, nothing asserted)");
}

void main();
