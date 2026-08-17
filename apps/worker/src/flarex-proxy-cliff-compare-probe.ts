/**
 * DEBT-033 STOP 1: does the admission-cliff move when ingest proxies are FULLY BUILT before playback,
 * versus ABSENT (playing immediately after import, the way a human clean-room test plausibly did)?
 *
 * `flarex-playback-collapse-probe.ts`'s third (working) iteration measured N=1/3/6/10 with proxies
 * confirmed ready first — `waitForProxies` blocks on `queued===0 && active===null`. That was the right
 * fix for THAT probe's confound (fresh imports defaulting to native decode), but it also means every
 * capMisses/admissionDenials number on file so far is the WARM-proxy case. The founder's own hand test
 * uploaded and started playing quickly — plausibly the COLD case. If proxies change which decode path a
 * layer takes (`preferNativeDecode` in VideoPreview.tsx keys off `isIngestProxyUrl`), the cliff itself
 * could be at a different N, or not present at all, in the cold case.
 *
 * This probe runs BOTH conditions back-to-back at the SAME N values so they are directly comparable:
 *   WARM — identical to the collapse probe: wait for `__rfSourceProxy` idle before playing.
 *   COLD — play ~2s after the last clip lands on the timeline, no proxy wait at all.
 *
 * Reads `__rfWcPool` (capMisses/admissionDenials — direct admission-denial evidence) and `__rfWcMode`
 * (per-source decode path tally) in both arms.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-proxy-cliff-compare-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { defaultClipPath, importAssets, reachEditor } from "./browser/editor-session.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const N_LADDER = [3, 6, 10];
const PLAY_SETTLE_MS = 6_000;
const PROXY_WAIT_TIMEOUT_MS = 45_000;
const COLD_WAIT_MS = 2_000;

function seedClips(count: number): string[] {
  const dir = path.join(repoRoot, "apps/api/storage/finals");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  if (files.length < count) throw new Error(`need ${count} distinct clips, found ${files.length}`);
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

async function waitForProxies(page: Page, timeoutMs: number): Promise<{ ready: boolean; snapshot: unknown }> {
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

async function censusAfterPlay(page: Page) {
  await page.keyboard.press("Home").catch(() => undefined);
  await page.waitForTimeout(300);
  await page.keyboard.press("Space").catch(() => undefined);
  await page.waitForTimeout(PLAY_SETTLE_MS);

  const census = await page.evaluate(() => {
    const w = window as unknown as {
      __rfWcMode?: Record<string, string>;
      __rfWcPool?: Record<string, unknown>;
      __rfVideoPoolStats?: Record<string, unknown>;
    };
    return { wcMode: w.__rfWcMode ?? {}, wcPool: w.__rfWcPool ?? {}, videoPool: w.__rfVideoPoolStats ?? {} };
  });

  await page.keyboard.press("Space").catch(() => undefined);

  const modeCounts: Record<string, number> = {};
  for (const mode of Object.values(census.wcMode)) modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
  return { ...census, modeCounts };
}

async function runArm(
  channel: string | undefined,
  n: number,
  allClips: string[],
  mode: "warm" | "cold"
): Promise<Record<string, unknown>> {
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  const projectUrl = await reachEditor(page, { clipPath: defaultClipPath(20), flags: "wcDecode=1" });
  console.log(`  [${mode}] project: ${projectUrl}`);
  await page.waitForTimeout(3_000);

  if (n > 1) {
    const imported = await importAssets(page, allClips.slice(0, n - 1));
    console.log(`  [${mode}] imported: ${imported} additional asset tile(s)`);
  }
  const placed = await addClipsToTimeline(page, n);
  console.log(`  [${mode}] placed on timeline: ${placed}/${n}`);
  if (placed < n) {
    console.log(`  ⚠ VOID for N=${n} [${mode}] — only ${placed}/${n} clips landed.`);
    await browser.close();
    return { void: true };
  }

  let proxyState: { ready: boolean; snapshot: unknown } | null = null;
  if (mode === "warm") {
    console.log(`  [${mode}] waiting for ingest proxies (bounded ${PROXY_WAIT_TIMEOUT_MS}ms)...`);
    proxyState = await waitForProxies(page, PROXY_WAIT_TIMEOUT_MS);
    console.log(`  [${mode}] proxies ready: ${proxyState.ready} — ${JSON.stringify(proxyState.snapshot)}`);
  } else {
    await page.waitForTimeout(COLD_WAIT_MS);
    const snap = await page.evaluate(() => {
      const w = window as unknown as { __rfSourceProxy?: unknown };
      return w.__rfSourceProxy ?? null;
    });
    console.log(`  [${mode}] proxy state at play time (NOT waited on): ${JSON.stringify(snap)}`);
    proxyState = { ready: false, snapshot: snap };
  }

  const census = await censusAfterPlay(page);
  console.log(`  [${mode}] __rfWcPool: ${JSON.stringify(census.wcPool)}`);
  console.log(`  [${mode}] mode tally: ${JSON.stringify(census.modeCounts)}`);

  await browser.close();
  return { proxyState, ...census };
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex-proxy-cliff-compare-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");

  const maxNeeded = Math.max(...N_LADDER);
  const allClips = seedClips(maxNeeded);
  const results: Record<number, { warm: Record<string, unknown>; cold: Record<string, unknown> }> = {};

  for (const n of N_LADDER) {
    console.log(`\n########## N=${n} ##########`);
    console.log(` -- WARM (proxies ready before play) --`);
    const warm = await runArm(channel, n, allClips, "warm");
    console.log(` -- COLD (play ~${COLD_WAIT_MS}ms after import, no proxy wait) --`);
    const cold = await runArm(channel, n, allClips, "cold");
    results[n] = { warm, cold };
  }

  console.log("\n\n=== SUMMARY: warm vs cold admission state per N ===");
  for (const n of N_LADDER) {
    const r = results[n]!;
    console.log(`  N=${n}`);
    console.log(`    warm: wcPool=${JSON.stringify((r.warm as { wcPool?: unknown }).wcPool)} modes=${JSON.stringify((r.warm as { modeCounts?: unknown }).modeCounts)}`);
    console.log(`    cold: wcPool=${JSON.stringify((r.cold as { wcPool?: unknown }).wcPool)} modes=${JSON.stringify((r.cold as { modeCounts?: unknown }).modeCounts)}`);
  }

  console.log("\nflarex-proxy-cliff-compare-probe: complete (measurement only, nothing asserted)");
}

void main();
