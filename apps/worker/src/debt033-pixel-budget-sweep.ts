/**
 * DEBT-033 — WHERE IS THE UN-PROXIED DECODE BOUNDARY, IN PIXELS PER FRAME?
 *
 * THE QUESTION, and why the unit is pixels. On the WARM path every proxy is normalised to a 1280 long
 * edge (asserted in `sourceProxyNotice.test.ts`: a 2160x3840 and a 1080x1920 source both encode to
 * 720x1280), so a proxied stream costs the decoder the same whatever it came from and counting streams
 * is sound. On the COLD path a stream is whatever the source is — 4K carries ~4x the pixels of 1080p —
 * so a stream COUNT describes a fourfold-varying workload. This sweep measures the cold boundary in the
 * only unit that can describe it.
 *
 * WHAT IS MEASURED, and where. The canvas, not pool counters: the claim is about what a user sees.
 * A tier/N arm PASSES if the preview keeps changing while the clock advances, and FAILS if the picture
 * stops. Total load for an arm is `N x (width x height)` megapixels per frame.
 *
 * DERIVED, NOT PICKED. Prior single runs bracket it loosely — cold 4K (8.29 Mpx) froze at N=3, cold
 * 1080p (2.07 Mpx) still delivered at N=6 — which is ~12-25 Mpx depending which side you read. Single
 * runs are exactly what DEBT-032's lesson forbids trusting, so every arm here is REPEATED and the
 * scatter is reported. A boundary quoted without its spread is a number pretending to be a measurement.
 *
 * THE CONFOUND THIS PROBE MUST AVOID. Since the play-trap fix, a frozen cold playback no longer
 * suspends proxy builds — so a proxy can COMPLETE mid-arm and change the very thing being measured.
 * Each arm therefore records `built` per sample and TRUNCATES at the first increment, reporting how
 * much of the window was clean. An arm whose picture only recovered after a proxy landed is not
 * evidence about un-proxied decode.
 *
 * Run:
 *   PROBE_TIERS=1080p,1440p,4k PIXEL_BROWSER_CHANNEL=chrome \
 *     pnpm --filter @orreris/worker tsx src/debt033-pixel-budget-sweep.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { importAssets, reachEditor } from "./browser/editor-session.js";

const SCRATCH =
  process.env.PROBE_SCRATCH ??
  "C:/Users/rosha/AppData/Local/Temp/claude/c--Users-rosha-Documents-Web-trendcut/f819ae1a-cdc4-4be4-aea2-e3209b558aa1/scratchpad";

interface Tier {
  key: string;
  dir: string;
  mpxPerFrame: number;
  ladder: number[];
}

const TIERS: Tier[] = [
  { key: "1080p", dir: `${SCRATCH}/1080p`, mpxPerFrame: (1080 * 1920) / 1e6, ladder: [4, 6, 8] },
  { key: "1440p", dir: `${SCRATCH}/1440p`, mpxPerFrame: (1440 * 2560) / 1e6, ladder: [2, 3, 4] },
  { key: "4k", dir: `${SCRATCH}/4k`, mpxPerFrame: (2160 * 3840) / 1e6, ladder: [1, 2, 3] }
];

const REPEATS = Number(process.env.PROBE_REPEATS ?? 3);
const SAMPLES = 16;
const SAMPLE_MS = 700;
const CANVAS_SELECTOR = "canvas.preview-scene-canvas";

function clipsIn(dir: string, count: number): string[] {
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".mp4")).map((n) => path.join(dir, n)).sort();
  if (files.length < count) throw new Error(`need ${count} clips in ${dir}, found ${files.length}`);
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
  moving: boolean;
  changedRatio: number;
  cleanSamples: number;
  clockAdvanced: number;
  void?: string;
}

async function runArm(channel: string | undefined, tier: Tier, n: number): Promise<ArmResult> {
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = context.pages()[0] ?? (await context.newPage());
  const all = clipsIn(tier.dir, n);
  try {
    await reachEditor(page, { clipPath: all[0]!, flags: "wcDecode=1" });
    await page.waitForTimeout(2_500);
    if (n > 1) await importAssets(page, all.slice(1, n));
    const placed = await addClips(page, n);
    if (placed < n) return { moving: false, changedRatio: 0, cleanSamples: 0, clockAdvanced: 0, void: `only ${placed}/${n} placed` };

    const canvas = page.locator(CANVAS_SELECTOR).first();
    if (!(await canvas.count().catch(() => 0))) {
      return { moving: false, changedRatio: 0, cleanSamples: 0, clockAdvanced: 0, void: "no canvas" };
    }

    await page.waitForTimeout(1_500); // COLD: no proxy wait
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(250);
    await page.keyboard.press("Space").catch(() => undefined);

    let prev: string | null = null;
    let changed = 0;
    let compared = 0;
    let builtAtStart: number | null = null;
    let clockFirst: number | null = null;
    let clockLast: number | null = null;
    for (let i = 0; i < SAMPLES; i++) {
      await page.waitForTimeout(SAMPLE_MS);
      const shot = await canvas.screenshot({ timeout: 5_000 }).catch(() => null);
      const hash = shot ? crypto.createHash("sha1").update(shot).digest("hex").slice(0, 12) : `X${i}`;
      const st = (await page.evaluate(`(function () {
        var p = window.__rfSourceProxy || null;
        var c = window.__rfClock || null;
        return { built: p ? p.built : 0, clock: c ? c.committed : null };
      })()`)) as { built: number; clock: number | null };
      if (builtAtStart === null) builtAtStart = st.built;
      // A completed proxy changes the subject: from here the arm is no longer measuring un-proxied
      // decode, so stop rather than average the two regimes together.
      if (st.built > builtAtStart) break;
      if (st.clock != null) {
        if (clockFirst === null) clockFirst = st.clock;
        clockLast = st.clock;
      }
      if (prev !== null) {
        compared += 1;
        if (hash !== prev) changed += 1;
      }
      prev = hash;
    }
    await page.keyboard.press("Space").catch(() => undefined);

    const clockAdvanced = clockFirst != null && clockLast != null ? clockLast - clockFirst : 0;
    if (compared < 4) return { moving: false, changedRatio: 0, cleanSamples: compared, clockAdvanced, void: "too few clean samples" };
    if (clockAdvanced < 1) return { moving: false, changedRatio: 0, cleanSamples: compared, clockAdvanced, void: "clock did not advance" };
    const ratio = changed / compared;
    // "Moving" = the picture is genuinely updating, not one stray repaint. Deliberately generous: this
    // sweep looks for the boundary where motion STOPS, not for smoothness.
    return { moving: ratio >= 0.5, changedRatio: ratio, cleanSamples: compared, clockAdvanced };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "debt033-pixel-budget-sweep" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");
  const wanted = (process.env.PROBE_TIERS ?? "1080p,1440p,4k").split(",").map((s) => s.trim());
  const tiers = TIERS.filter((t) => wanted.includes(t.key));

  const rows: Array<{ tier: string; n: number; mpx: number; movingRuns: number; runs: number; ratios: number[]; voids: string[] }> = [];

  for (const tier of tiers) {
    for (const n of tier.ladder) {
      const mpx = Number((n * tier.mpxPerFrame).toFixed(2));
      const ratios: number[] = [];
      const voids: string[] = [];
      let movingRuns = 0;
      for (let r = 0; r < REPEATS; r++) {
        const res = await runArm(channel, tier, n);
        if (res.void) {
          voids.push(res.void);
          console.log(`  ${tier.key} N=${n} (${mpx} Mpx) run ${r + 1}: VOID — ${res.void}`);
          continue;
        }
        ratios.push(Number(res.changedRatio.toFixed(2)));
        if (res.moving) movingRuns += 1;
        console.log(
          `  ${tier.key} N=${n} (${mpx} Mpx) run ${r + 1}: ${res.moving ? "MOVING" : "FROZEN"} changed=${(res.changedRatio * 100).toFixed(0)}% clean=${res.cleanSamples} clock=+${res.clockAdvanced.toFixed(1)}s`
        );
      }
      rows.push({ tier: tier.key, n, mpx, movingRuns, runs: ratios.length, ratios, voids });
    }
  }

  console.log(`\n\n=== PIXEL BUDGET SWEEP (cold / un-proxied), ${REPEATS} repeats per arm ===`);
  console.log("  tier    N   Mpx/frame   moving   changed-ratio scatter");
  for (const r of rows) {
    console.log(
      `  ${r.tier.padEnd(7)} ${String(r.n).padEnd(3)} ${String(r.mpx).padEnd(11)} ${`${r.movingRuns}/${r.runs}`.padEnd(8)} ${JSON.stringify(r.ratios)}${r.voids.length ? ` voids=${JSON.stringify(r.voids)}` : ""}`
    );
  }

  const moving = rows.filter((r) => r.runs > 0 && r.movingRuns === r.runs).map((r) => r.mpx);
  const frozen = rows.filter((r) => r.runs > 0 && r.movingRuns === 0).map((r) => r.mpx);
  const mixed = rows.filter((r) => r.runs > 0 && r.movingRuns > 0 && r.movingRuns < r.runs);
  console.log(`\n  always moving up to: ${moving.length ? Math.max(...moving) + " Mpx" : "—"}`);
  console.log(`  always frozen from:  ${frozen.length ? Math.min(...frozen) + " Mpx" : "—"}`);
  if (mixed.length) {
    console.log(`  MIXED (the boundary is here, and it is not sharp): ${mixed.map((m) => `${m.mpx} Mpx ${m.movingRuns}/${m.runs}`).join(", ")}`);
  }
  console.log("\ndebt033-pixel-budget-sweep: complete (measurement only, nothing asserted)");
}

void main();
