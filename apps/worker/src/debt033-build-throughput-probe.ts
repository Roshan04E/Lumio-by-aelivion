/**
 * DEBT-033 — DOES PARALLELISING PROXY BUILDS BUY ANY THROUGHPUT? Measure before changing anything.
 *
 * WHY THIS IS NOW THE FRONT-LINE QUESTION. The play gate turned "a frozen preview" into "a progress
 * window", which is a much better failure — and it makes BUILD THROUGHPUT the wait itself. Eleven 4K
 * clips at 15-89s each, serially, is five minutes of someone watching a bar.
 *
 * WHY IT IS EMPIRICAL RATHER THAN OBVIOUS. Every build opens a decode session plus an encoder. If the
 * bottleneck is the GPU's video block — `video-element-pool.ts`'s header names ~2-3 concurrent hardware
 * decode sessions on integrated GPUs — then three builds each run at a third speed, TOTAL THROUGHPUT IS
 * FLAT, and parallelising would buy the `preview-frame-pool.ts:107` crash risk (a 3+4 split raised the
 * real ceiling to 7 and killed the GPU process) for nothing. If instead the bottleneck is CPU threads,
 * the curve scales and the change is worth designing as ONE budget spanning builds and playback.
 *
 * A MEASURED NO IS A RESULT. This probe changes no default: concurrency is set per-arm through the
 * `__rfSourceProxyConcurrency` debug seam, which the product itself never calls.
 *
 * WHAT IS MEASURED: proxies COMPLETED per minute — `__rfSourceProxy.built` over wall time, from the
 * moment the queue starts to the moment it drains. Repeats per arm with the scatter reported, because
 * DEBT-032's lesson is that a single reading of a noisy quantity is a confident guess.
 *
 * MEDIA: five 4K clips, not eleven. Eleven ~120MB imports exceed this harness profile's ~0.85GB storage
 * allowance (DEBT-034), so four or five of them fail to persist and never build — which would silently
 * change the denominator between arms. Five fit with margin, so every arm has the same work to do.
 *
 * Run:
 *   PROBE_4K_DIR=<dir> PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/debt033-build-throughput-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { importAssets, reachEditor } from "./browser/editor-session.js";

const N = Number(process.env.PROBE_N ?? 5);
const REPEATS = Number(process.env.PROBE_REPEATS ?? 3);
const LEVELS = (process.env.PROBE_CONCURRENCY ?? "1,2,3").split(",").map((s) => Number(s.trim()));
const DRAIN_TIMEOUT_MS = Number(process.env.PROBE_DRAIN_TIMEOUT_MS ?? 600_000);

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
    await page.waitForTimeout(120);
    const add = tile.locator('button[title="Add video only"]').first();
    if (!(await add.count().catch(() => 0))) break;
    await add.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(350);
    placed += 1;
  }
  return placed + 1;
}

interface ArmResult {
  built: number;
  failed: number;
  skipped: number;
  seconds: number;
  perMinute: number;
  maxConcurrentSeen: number;
  void?: string;
}

async function runArm(channel: string | undefined, concurrency: number, files: string[]): Promise<ArmResult> {
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = context.pages()[0] ?? (await context.newPage());
  const empty: ArmResult = { built: 0, failed: 0, skipped: 0, seconds: 0, perMinute: 0, maxConcurrentSeen: 0 };
  try {
    await reachEditor(page, { clipPath: files[0]!, flags: "wcDecode=1" });
    await page.waitForTimeout(2_500);

    const applied = (await page.evaluate(`window.__rfSourceProxyConcurrency ? window.__rfSourceProxyConcurrency(${concurrency}) : null`)) as number | null;
    if (applied !== concurrency) {
      return { ...empty, void: `concurrency seam unavailable or refused (asked ${concurrency}, got ${applied})` };
    }

    if (N > 1) await importAssets(page, files.slice(1, N));
    const placed = await addClips(page, N);
    if (placed < N) return { ...empty, void: `only ${placed}/${N} clips placed` };

    // Re-apply: the import path may have run before the seam was set on a fresh module instance.
    await page.evaluate(`window.__rfSourceProxyConcurrency && window.__rfSourceProxyConcurrency(${concurrency})`);

    const started = Date.now();
    let maxConcurrentSeen = 0;
    let last: { built: number; failed: number; skipped: number; queued: number; active: unknown } | null = null;
    let idleStreak = 0;
    while (Date.now() - started < DRAIN_TIMEOUT_MS) {
      await page.waitForTimeout(1_000);
      const snap = (await page.evaluate(`(function () {
        var p = window.__rfSourceProxy || null;
        if (!p) return null;
        return { built: p.built, failed: p.failed, skipped: p.skipped, queued: p.queued, active: p.active, drains: p.activeDrains || null };
      })()`)) as { built: number; failed: number; skipped: number; queued: number; active: unknown; drains: number | null } | null;
      if (!snap) continue;
      last = snap;
      if (snap.drains && snap.drains > maxConcurrentSeen) maxConcurrentSeen = snap.drains;
      const settledCount = snap.built + snap.failed + snap.skipped;
      if (snap.queued === 0 && snap.active === null && settledCount >= N) {
        idleStreak += 1;
        if (idleStreak >= 3) break;
      } else {
        idleStreak = 0;
      }
    }
    const seconds = (Date.now() - started) / 1000;
    if (!last) return { ...empty, void: "no telemetry" };
    const built = last.built;
    return {
      built,
      failed: last.failed,
      skipped: last.skipped,
      seconds: Number(seconds.toFixed(1)),
      perMinute: Number(((built / seconds) * 60).toFixed(2)),
      maxConcurrentSeen
    };
  } finally {
    await browser.close();
  }
}

function mean(xs: number[]): number {
  return xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : NaN;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "debt033-build-throughput-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");
  const files = clips(N);
  console.log(`media: ${N} 4K clips; concurrency levels ${JSON.stringify(LEVELS)}; ${REPEATS} repeats each\n`);

  const table: Array<{ level: number; rates: number[]; builts: number[]; times: number[]; voids: string[] }> = [];
  for (const level of LEVELS) {
    const rates: number[] = [];
    const builts: number[] = [];
    const times: number[] = [];
    const voids: string[] = [];
    for (let r = 0; r < REPEATS; r++) {
      const res = await runArm(channel, level, files);
      if (res.void) {
        voids.push(res.void);
        console.log(`  concurrency ${level} run ${r + 1}: VOID — ${res.void}`);
        continue;
      }
      rates.push(res.perMinute);
      builts.push(res.built);
      times.push(res.seconds);
      console.log(
        `  concurrency ${level} run ${r + 1}: ${res.built} built / ${res.failed} failed / ${res.skipped} skipped in ${res.seconds}s = ${res.perMinute} proxies/min`
      );
    }
    table.push({ level, rates, builts, times, voids });
  }

  console.log(`\n\n=== BUILD THROUGHPUT vs CONCURRENCY (${N} x 4K, ${REPEATS} repeats) ===`);
  console.log("  concurrency   proxies/min (mean)   scatter                built counts     wall seconds");
  for (const row of table) {
    console.log(
      `  ${String(row.level).padEnd(13)} ${String(mean(row.rates)).padEnd(20)} ${JSON.stringify(row.rates).padEnd(22)} ${JSON.stringify(row.builts).padEnd(16)} ${JSON.stringify(row.times)}${row.voids.length ? ` voids=${JSON.stringify(row.voids)}` : ""}`
    );
  }

  const base = table.find((r) => r.level === 1);
  if (base && base.rates.length) {
    const baseline = mean(base.rates);
    console.log(`\n  relative to concurrency 1 (${baseline} proxies/min):`);
    for (const row of table) {
      if (row.level === 1 || !row.rates.length) continue;
      const ratio = mean(row.rates) / baseline;
      console.log(`    concurrency ${row.level}: ${ratio.toFixed(2)}x`);
    }
    console.log(
      `\n  READ IT AS: ~1.0x means the bottleneck is NOT the number of build loops (the GPU video block,\n` +
        `  per video-element-pool.ts's ~2-3 hardware sessions) — parallelising would buy the documented\n` +
        `  GPU-crash risk for nothing, and concurrency should stay at 1. Meaningfully >1.0x means it scales\n` +
        `  and is worth building AS ONE BUDGET spanning builds and playback, never a second cap.`
    );
  }
  console.log("\ndebt033-build-throughput-probe: complete (measurement only, nothing asserted)");
}

void main();
