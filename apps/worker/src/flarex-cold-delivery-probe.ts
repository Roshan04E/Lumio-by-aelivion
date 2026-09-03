/**
 * DEBT-033 STOP 1 (2026-08-17): does the COLD case — fresh upload, played within seconds, no ingest
 * proxy yet — actually collapse per-layer delivery, and at what N?
 *
 * WHY THIS EXISTS. `flarex-proxy-cliff-compare-probe.ts` established that the cold case produces ZERO
 * WebCodecs admission denials at every N (sources default to the native `<video>` path via
 * `preferNativeDecode` before their proxy exists, so they never reach the admission gate at all). But
 * that probe read only the POOL census, never delivery — so "the founder's freeze is not the admission
 * cliff" was established by elimination while the positive claim was left unmeasured. This closes that
 * gap, and it is the whole question:
 *
 *   - cold delivery COLLAPSES at 6 with zero WC denials  → the uncapped native `<video>` path is the
 *     product defect (`video-element-pool.ts`: `active` is a plain uncapped counter, and that file's own
 *     header states integrated GPUs expose only ~2-3 concurrent hardware decode sessions).
 *   - cold delivery is FINE                              → the founder's freeze is explained by NEITHER
 *     path and the whole chapter has been looking at the wrong thing. That outcome must be reported
 *     loudly, not buried.
 *
 * WHAT IT CAPTURES, and nothing else: exactly what the founder saw on the HUD, via `__rfFrameStats` —
 * `minMediaFps` (the per-layer MINIMUM shipped this session, NOT the old sum, which is what made a
 * 6-layer collapse read as healthy), `activeMediaLayers`, `droppedRatio`, and `fps` (the compositor
 * repaint rate — kept because the founder's whole report was "FPS says 62 over a frozen picture", so
 * showing the two side by side IS the finding).
 *
 * `minMediaFps` is fed by `requestVideoFrameCallback` on the `<video>` element path — which is exactly
 * the path the cold case uses, so it is the right instrument here. It does NOT observe WebCodecs-mode
 * layers (a known, documented gap), which is harmless for this probe and would not be for a warm one.
 *
 * Samples over a window rather than taking one reading: a single sample at an arbitrary instant cannot
 * tell a steady collapse from a transient mid-startup dip, and this chapter has burned three sessions
 * on instruments that could not tell two answers apart.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-cold-delivery-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { defaultClipPath, importAssets, reachEditor } from "./browser/editor-session.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const N_LADDER = [1, 3, 6, 10];
/** Play ~2s after the last clip lands — the COLD condition (a human uploading and hitting play). */
const COLD_WAIT_MS = 2_000;
const SAMPLE_COUNT = 10;
const SAMPLE_INTERVAL_MS = 1_000;
/** Every clip must outlast the whole sample window with margin — see `seedClips`. */
const MIN_CLIP_SECONDS = 15;

interface DeliverySample {
  t: number;
  fps: number;
  minMediaFps: number | null;
  mediaFps: number;
  activeMediaLayers: number;
  droppedRatio: number;
  playing: boolean;
}

/** Duration from the mp4 `mvhd` box (same dependency-free read `editor-session.ts` uses), or null. */
function mp4DurationSeconds(file: string): number | null {
  try {
    const bytes = fs.readFileSync(file);
    const at = bytes.indexOf(Buffer.from("mvhd"));
    if (at < 0) return null;
    const version = bytes[at + 4];
    if (version === 0) {
      const timescale = bytes.readUInt32BE(at + 16);
      return timescale > 0 ? bytes.readUInt32BE(at + 20) / timescale : null;
    }
    const timescale = bytes.readUInt32BE(at + 24);
    return timescale > 0 ? Number(bytes.readBigUInt64BE(at + 28)) / timescale : null;
  } catch {
    return null;
  }
}

/**
 * Clips that OUTLAST the sample window, smallest-first among those.
 *
 * THE FIRST RUN OF THIS PROBE WAS CONFOUNDED BY EXACTLY THIS and the result had to be thrown away:
 * picking smallest-first without a duration filter selected 0.7s-4.4s clips, which ENDED partway
 * through the 10s window. A layer whose clip has finished stops ticking `requestVideoFrameCallback`
 * and therefore reads `minMediaFps = 0.0` — indistinguishable from the stalled-decoder collapse this
 * probe exists to detect. The layer count visibly decayed (3 → 1 at N=6, 7 → 2 at N=10) while fps
 * recovered, which is the signature of load draining away, not of a machine coping.
 *
 * `editor-session.ts:65` already carries this scar for the SEED clip ("a seed clip must outlast the
 * window that samples it") — the same rule has to apply to every imported clip, not just the seed.
 */
function seedClips(count: number): string[] {
  const dir = path.join(repoRoot, "apps/api/storage/finals");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .map((file) => ({ file, seconds: mp4DurationSeconds(file) }))
    .filter((entry) => entry.seconds != null && entry.seconds >= MIN_CLIP_SECONDS)
    .sort((a, b) => fs.statSync(a.file).size - fs.statSync(b.file).size)
    .map((entry) => entry.file);
  if (files.length < count) {
    throw new Error(`need ${count} distinct clips of >=${MIN_CLIP_SECONDS}s, found ${files.length}`);
  }
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
    await page.waitForTimeout(400);
    placed += 1;
  }
  return placed + 1;
}

/** Median of a numeric list — reported alongside the mean because one stalled sample must not be
 *  averaged into looking like a mild dip, nor one healthy sample average away a real collapse. */
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function runColdArm(channel: string | undefined, n: number, allClips: string[]) {
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  await reachEditor(page, { clipPath: defaultClipPath(20), flags: "wcDecode=1" });
  await page.waitForTimeout(3_000);

  if (n > 1) await importAssets(page, allClips.slice(0, n - 1));
  const placed = await addClipsToTimeline(page, n);
  console.log(`  placed on timeline: ${placed}/${n}`);
  if (placed < n) {
    console.log(`  ⚠ VOID for N=${n} — only ${placed}/${n} clips landed.`);
    await browser.close();
    return null;
  }

  // COLD: no proxy wait. Record what the proxy engine was still doing, to prove the arm really was cold.
  await page.waitForTimeout(COLD_WAIT_MS);
  const proxyAtPlay = await page.evaluate(() => {
    const w = window as unknown as { __rfSourceProxy?: unknown };
    return w.__rfSourceProxy ?? null;
  });
  console.log(`  proxy state at play time (NOT waited on): ${JSON.stringify(proxyAtPlay)}`);

  await page.keyboard.press("Home").catch(() => undefined);
  await page.waitForTimeout(300);
  await page.keyboard.press("Space").catch(() => undefined);

  const samples: DeliverySample[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    const s = await page.evaluate(() => {
      const w = window as unknown as {
        __rfFrameStats?: {
          fps: number;
          minMediaFps: number | null;
          mediaFps: number;
          activeMediaLayers: number;
          droppedRatio: number;
          playing: boolean;
        };
      };
      const f = w.__rfFrameStats;
      return f
        ? {
            fps: f.fps,
            minMediaFps: f.minMediaFps,
            mediaFps: f.mediaFps,
            activeMediaLayers: f.activeMediaLayers,
            droppedRatio: f.droppedRatio,
            playing: f.playing,
          }
        : null;
    });
    if (s) samples.push({ t: i + 1, ...s });
  }

  const wcPool = await page.evaluate(() => {
    const w = window as unknown as { __rfWcPool?: { capMisses?: number; admissionDenials?: number } };
    return { capMisses: w.__rfWcPool?.capMisses ?? null, admissionDenials: w.__rfWcPool?.admissionDenials ?? null };
  });
  const videoPool = await page.evaluate(() => {
    const w = window as unknown as { __rfVideoPoolStats?: unknown };
    return w.__rfVideoPoolStats ?? null;
  });

  await page.keyboard.press("Space").catch(() => undefined);
  await browser.close();
  return { samples, wcPool, videoPool, proxyAtPlay };
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex-cold-delivery-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");

  const allClips = seedClips(Math.max(...N_LADDER));
  const results: Record<number, Awaited<ReturnType<typeof runColdArm>>> = {};

  for (const n of N_LADDER) {
    console.log(`\n########## COLD N=${n} ##########`);
    const r = await runColdArm(channel, n, allClips);
    results[n] = r;
    if (!r) continue;
    for (const s of r.samples) {
      console.log(
        `    t=${s.t}s fps=${s.fps.toFixed(1)} minMedia=${s.minMediaFps == null ? "null" : s.minMediaFps.toFixed(1)}` +
          ` mediaSum=${s.mediaFps.toFixed(1)} layers=${s.activeMediaLayers} dropped=${(s.droppedRatio * 100).toFixed(0)}%` +
          ` playing=${s.playing}`
      );
    }
    console.log(`    wcPool: ${JSON.stringify(r.wcPool)}  videoPool: ${JSON.stringify(r.videoPool)}`);
  }

  console.log("\n\n=== SUMMARY: COLD per-layer delivery vs compositor FPS ===");
  console.log("  N   fps(med)  minMediaFps(med)  minMediaFps(min)  mediaSum(med)  layers  dropped(med)  capMisses");
  for (const n of N_LADDER) {
    const r = results[n];
    if (!r) {
      console.log(`  ${n}: VOID`);
      continue;
    }
    const playing = r.samples.filter((s) => s.playing);
    const use = playing.length > 0 ? playing : r.samples;
    const mins = use.map((s) => (s.minMediaFps == null ? NaN : s.minMediaFps)).filter((v) => !Number.isNaN(v));
    console.log(
      `  ${String(n).padEnd(3)} ${median(use.map((s) => s.fps)).toFixed(1).padEnd(9)}` +
        ` ${(mins.length ? median(mins).toFixed(1) : "n/a").padEnd(17)}` +
        ` ${(mins.length ? Math.min(...mins).toFixed(1) : "n/a").padEnd(17)}` +
        ` ${median(use.map((s) => s.mediaFps)).toFixed(1).padEnd(14)}` +
        ` ${String(median(use.map((s) => s.activeMediaLayers))).padEnd(7)}` +
        ` ${(median(use.map((s) => s.droppedRatio)) * 100).toFixed(0).padEnd(13)}%` +
        ` ${r.wcPool.capMisses}`
    );
  }
  console.log("\nflarex-cold-delivery-probe: complete (measurement only, nothing asserted)");
}

void main();
