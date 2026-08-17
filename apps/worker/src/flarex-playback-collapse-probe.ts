/**
 * Reproduces the founder's clean-room playback finding as a real fixture, measurable without hands on
 * the HUD. Their hand run:
 *
 *   clips  FPS  Media  Dropped  Frame    Composite  Res   Decoders   observed
 *     1     73    -      1%     13.7ms     1.3ms    1/4     0+3      smooth
 *     3     62    -      4%     16.1ms     2.8ms    1/4     0+4      smooth
 *     6     62    75     6%     16.0ms     1.8ms    1/4     4+4      frozen ~95%
 *    10     38    28    33%     26.7ms     2.7ms    1/4     4+4      frozen
 *
 * STOP 1's hypothesis (founder's own, flagged unverified): below some clip-count threshold every layer
 * runs on WebCodecs; above it, layers fall back to the pooled `<video>` element, and per-layer delivery
 * collapses on that path. If true, the cliff is a PATH CHANGE (admission denial), not a gradual load
 * curve — decided by `MAX_WC_TOTAL_SESSIONS` (4, `preview-frame-pool.ts:113`), not by
 * `video-element-pool.ts`'s `MAX_IDLE` (4, caps only the idle set — `active` is an uncapped plain
 * counter there, so a 4-active plateau at both 6 and 10 clips is NOT explained by that file alone).
 *
 * Reads the SAME diagnostics DEBT-027's own prior work found readable without building anything new,
 * extended here to the pool census: `__rfWcMode` (per-source decode path: wc-hw/wc-sw/element),
 * `__rfWcPool` (WebCodecs session pool census, including `capMisses` — direct evidence of admission
 * denial), `__rfVideoPoolStats` (pooled `<video>` element active/idle/reused/created), and
 * `__rfSourceMap` (per-source served time / staleness — the same fields that diagnosed DEBT-027).
 *
 * Builds N real video layers on N DISTINCT clips, one per track, all starting at t=0.
 *
 * TWO PRIOR ATTEMPTS IN THIS FILE'S HISTORY, BOTH CONFOUNDED — recorded so a third attempt does not
 * repeat them:
 *   1. N distinct FRESH imports, played immediately. `VideoPreview.tsx:4014` sets
 *      `preferNativeDecode={!isIngestProxyUrl(mediaUrl, asset) && !hasMeasuredDenseGop(asset?.id)}` — a
 *      freshly imported asset has no ingest proxy yet, so EVERY arm (including N=1) measured "fresh
 *      import defaults to element", not concurrency.
 *   2. The SAME already-seeded clip restacked N times, to hold proxy-readiness constant. This surfaced
 *      a DIFFERENT real mechanism instead — `__rfWcPool`'s `shared`/`sharedFramesServed` engaged for
 *      identical-URL layers (session SHARING, one decoder serving several consumers of the same file) —
 *      not what N distinct real clips playing together would do, so still not the founder's scenario.
 *   3. THIS version: N DISTINCT imports, but placed on the timeline and then held (not yet playing)
 *      while polling `window.__rfSourceProxy` (`sourceProxyEngine.ts:111` — `{built, queued, active}`)
 *      until background proxy builds finish (`queued === 0 && active === null`) or a bounded timeout, so
 *      concurrency is measured against WARM assets the way the founder's clean-room session — running
 *      long enough for its own clips to have proxied — actually did.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-playback-collapse-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { defaultClipPath, importAssets, reachEditor } from "./browser/editor-session.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const N_LADDER = [1, 3, 6, 10];
const PLAY_SETTLE_MS = 6_000;
const PROXY_WAIT_TIMEOUT_MS = 45_000;

function seedClips(count: number): string[] {
  const dir = path.join(repoRoot, "apps/api/storage/finals");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size); // smallest first — fastest to proxy
  if (files.length < count) throw new Error(`need ${count} distinct clips, found ${files.length}`);
  return files.slice(0, count);
}

async function addClipsToTimeline(page: Page, count: number): Promise<number> {
  let placed = 0;
  // tile 0 is the seed clip reachEditor already placed once — skip it and use tiles 1..count for the
  // freshly imported ones, so we end with exactly `count` layers total (seed + count-1 imports).
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
  return placed + 1; // +1 for the seed clip's own original placement
}

async function waitForProxies(page: Page, timeoutMs: number): Promise<{ ready: boolean; snapshot: unknown }> {
  // A FIRST poll reading queued=0/active=null is ambiguous — it might mean "nothing to build" OR
  // "hasn't noticed the new assets yet". Require the idle reading on the SECOND poll onward (>=3s in),
  // by which point the engine has had time to notice and either queue work or confirm there is none.
  const start = Date.now();
  let snapshot: unknown = null;
  let poll = 0;
  while (Date.now() - start < timeoutMs) {
    snapshot = await page.evaluate(() => {
      const w = window as unknown as { __rfSourceProxy?: { built: number; queued: number; active: unknown; failed: number; skipped: number } };
      return w.__rfSourceProxy ?? null;
    });
    const s = snapshot as { queued: number; active: unknown } | null;
    poll += 1;
    if (poll >= 3 && s && s.queued === 0 && s.active === null) return { ready: true, snapshot };
    await page.waitForTimeout(1_000);
  }
  return { ready: false, snapshot };
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex-playback-collapse-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");

  const maxNeeded = Math.max(...N_LADDER);
  const allClips = seedClips(maxNeeded);
  const results: Record<number, unknown> = {};

  for (const n of N_LADDER) {
    console.log(`\n########## N=${n} ##########`);
    const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

    const projectUrl = await reachEditor(page, { clipPath: defaultClipPath(20), flags: "wcDecode=1" });
    console.log(`  project: ${projectUrl}`);
    await page.waitForTimeout(3_000);

    if (n > 1) {
      const imported = await importAssets(page, allClips.slice(0, n - 1));
      console.log(`  imported: ${imported} additional asset tile(s)`);
    }
    const placed = await addClipsToTimeline(page, n);
    console.log(`  placed on timeline: ${placed}/${n} (distinct clips)`);
    if (placed < n) {
      console.log(`  ⚠ VOID for N=${n} — only ${placed} of ${n} clips landed on the timeline.`);
      await browser.close();
      continue;
    }

    console.log(`  waiting for ingest proxies to build (bounded ${PROXY_WAIT_TIMEOUT_MS}ms)...`);
    const proxyState = await waitForProxies(page, PROXY_WAIT_TIMEOUT_MS);
    console.log(`  proxies ready: ${proxyState.ready} — ${JSON.stringify(proxyState.snapshot)}`);

    // Confirm they actually stacked at/near t=0 on distinct tracks rather than serializing.
    const trackCount = await page.evaluate(() => document.querySelectorAll(".timeline-track").length).catch(() => -1);
    const clipCount = await page.evaluate(() => document.querySelectorAll(".timeline-clip").length).catch(() => -1);
    console.log(`  timeline: ${trackCount} track(s), ${clipCount} clip(s)`);

    // Seek to 0, then play.
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(300);
    await page.keyboard.press("Space").catch(() => undefined); // play/pause toggle
    await page.waitForTimeout(PLAY_SETTLE_MS);

    const census = await page.evaluate(() => {
      const w = window as unknown as {
        __rfWcMode?: Record<string, string>;
        __rfWcPool?: Record<string, unknown>;
        __rfVideoPoolStats?: Record<string, unknown>;
        __rfSourceMap?: Record<string, unknown>;
        __rfClock?: { committed?: number; isPlaying?: boolean };
      };
      return {
        clock: w.__rfClock ?? null,
        wcMode: w.__rfWcMode ?? {},
        wcPool: w.__rfWcPool ?? {},
        videoPool: w.__rfVideoPoolStats ?? {},
        sourceMap: w.__rfSourceMap ?? {},
      };
    });

    // Stop playback before closing (avoid leaving a runaway decode session mid-teardown).
    await page.keyboard.press("Space").catch(() => undefined);

    console.log(`  clock: ${JSON.stringify(census.clock)}`);
    console.log(`  __rfWcPool: ${JSON.stringify(census.wcPool)}`);
    console.log(`  __rfVideoPoolStats: ${JSON.stringify(census.videoPool)}`);
    console.log(`  __rfWcMode (per source):`);
    const modeCounts: Record<string, number> = {};
    for (const [src, mode] of Object.entries(census.wcMode)) {
      modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
      console.log(`    ${src}: ${mode}`);
    }
    console.log(`  mode tally: ${JSON.stringify(modeCounts)}`);
    console.log(`  __rfSourceMap (per source):`);
    for (const [id, entry] of Object.entries(census.sourceMap)) {
      console.log(`    ${id}: ${JSON.stringify(entry)}`);
    }

    results[n] = { trackCount, clipCount, ...census, modeCounts };
    await browser.close();
  }

  console.log("\n\n=== SUMMARY: decode-path tally per N ===");
  for (const n of N_LADDER) {
    const r = results[n] as { modeCounts?: Record<string, number>; wcPool?: Record<string, unknown>; videoPool?: Record<string, unknown> } | undefined;
    if (!r) {
      console.log(`  N=${n}: VOID`);
      continue;
    }
    console.log(
      `  N=${n}: modes=${JSON.stringify(r.modeCounts)} wcPool=${JSON.stringify(r.wcPool)} videoPool=${JSON.stringify(r.videoPool)}`
    );
  }

  console.log("\nflarex-playback-collapse-probe: complete (measurement only, nothing asserted)");
}

void main();
