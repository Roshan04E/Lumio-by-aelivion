/**
 * WHY IS THE PROXY QUEUE PARKED? (2026-09-04)
 *
 * The throughput probe sat for ten minutes with ZERO builds completed, and CPU said why it was not just
 * slow: the busiest Chrome process burned 0.38s of CPU in 8 seconds (~4% of one core). A 4K transcode
 * pegs a core. The queue was PARKED, not grinding.
 *
 * This matters far beyond the measurement. The play gate now makes playback WAIT on this queue, so
 * anything that can park it indefinitely turns the new progress window into a permanent one — the same
 * failure the gate was built to remove, one layer along.
 *
 * Prime suspect, from the code: builds park on `waitWhileSuspended()`, which follows the WHOLE
 * background gate (`backgroundScheduler.ts`), and that gate closes for `playing`, `gesture`,
 * `exporting`, **`pressure`** and **`memory`** — the last two owned by the degradation controller,
 * which reacts to sustained long tasks and high JS heap. Five 4K assets in one tab is exactly the
 * shape that trips a heap threshold, and the renderer was sitting at ~900MB per process.
 *
 * So this reads the gate itself rather than guessing: `__rfBgGate` (live reasons + hold counts) beside
 * `__rfSourceProxy` (queued/active/built), sampled while the queue should be draining.
 *
 * Run:
 *   PROBE_4K_DIR=<dir> PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/debt033-queue-stall-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { importAssets, reachEditor } from "./browser/editor-session.js";

const N = Number(process.env.PROBE_N ?? 5);
const SAMPLES = Number(process.env.PROBE_SAMPLES ?? 40);

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

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "debt033-queue-stall-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const files = clips(N);

  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  await reachEditor(page, { clipPath: files[0]!, flags: "wcDecode=1" });
  await page.waitForTimeout(2_500);
  if (N > 1) await importAssets(page, files.slice(1, N));
  const placed = await addClips(page, N);
  console.log(`placed ${placed}/${N}\n`);

  console.log("  t     queued active built  drains  gateAllowed  gateReasons                  heapMB");
  for (let i = 0; i < SAMPLES; i++) {
    await page.waitForTimeout(3_000);
    const s = (await page.evaluate(`(function () {
      var p = window.__rfSourceProxy || null;
      var g = window.__rfBgGate || null;
      var mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
      return {
        queued: p ? p.queued : null,
        active: p ? (p.active ? String(p.active).slice(-6) : null) : null,
        built: p ? p.built : null,
        drains: p ? (p.activeDrains == null ? null : p.activeDrains) : null,
        gate: g,
        heapMB: mem
      };
    })()`)) as {
      queued: number | null;
      active: string | null;
      built: number | null;
      drains: number | null;
      gate: unknown;
      heapMB: number | null;
    };
    const gate = s.gate as { allowed?: boolean; reasons?: string[]; holds?: number } | null;
    console.log(
      `  ${String((i + 1) * 3).padStart(4)}s ${String(s.queued).padStart(6)} ${String(s.active).padStart(7)} ${String(s.built).padStart(5)} ${String(s.drains).padStart(7)}  ${String(gate?.allowed).padEnd(11)}  ${JSON.stringify(gate?.reasons ?? gate).padEnd(28)} ${s.heapMB ?? "?"}`
    );
    if (s.built != null && s.built >= N) break;
  }

  await browser.close();
  console.log("\ndebt033-queue-stall-probe: complete (diagnostic only)");
}

void main();
