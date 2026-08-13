/**
 * ADR-023 S2.6 — **is the list actually fast, and is it actually virtualized?**
 *
 * "A vast font library that doesn't feel laggy" is the founder's brief, and the plan is explicit
 * that the scroll must be MEASURED rather than eyeballed, with picker startup reported as a separate
 * number from steady-state scroll. Those are two different costs with two different causes — startup
 * is decoding 1942 rows and mounting a window; scrolling is re-slicing and re-laying-out that window
 * sixty times a second — and one number hides whichever of them is worse.
 *
 * **The structural assertion matters more than the timings.** A machine has a bad second; a list that
 * mounts 1942 rows is broken permanently, and on a fast enough box it might still post acceptable
 * frame times while doing it. So the mounted-row count is asserted directly: whatever the clock says,
 * the list must be a WINDOW.
 *
 * The pick assertion rides along, because it needs the same page: picking must write a `FontRef`
 * with a `fileHash`. The entire S2 contract is downstream of that one write, and a picker that wrote
 * a family string would look identical on screen.
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker font:picker-perf
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { fontIndex } from "@orreris/shared";
import { assertQuietBrowserMachine, listAutomationBrowsers } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startWebServer(port: number) {
  // shell:true so Windows resolves `pnpm` → `pnpm.cmd` (see render-pixel-comparison for the why).
  const child = spawn(
    "pnpm",
    ["--dir", path.join(repoRoot, "apps/web"), "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, env: { ...process.env, BROWSER: "none" }, stdio: ["ignore", "pipe", "pipe"], shell: true }
  );
  child.stdout.on("data", (data) => process.stdout.write(`[web] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[web] ${data}`));
  return child;
}

/** Reap the vite TREE — `child.kill()` orphans the node process holding the port under `shell:true`. */
function stopWebServer(child: { pid?: number | undefined; kill: () => void }): void {
  if (child.pid && process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      return;
    } catch {
      // fall through to the portable kill
    }
  }
  child.kill();
}

async function waitForServer(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`web server never answered at ${url}`);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "font:picker-perf", scriptMarker: "font-picker-perf-gate" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);

  const totalFamilies = fontIndex().length;
  assert.ok(totalFamilies > 1000, "the index is too small for this gate to be measuring anything.");

  const port = await getFreePort();
  const vite = startWebServer(port);
  const base = `http://127.0.0.1:${port}`;
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) process.stdout.write("NOTE: PIXEL_BROWSER_CHANNEL unset — running on bundled Chromium.\n");

  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    await waitForServer(base);
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    page.on("pageerror", (error) => process.stdout.write(`[pageerror] ${String(error)}\n`));
    await page.goto(`${base}/editor/__preview-fixture?catalogue=picker`, { waitUntil: "networkidle" });
    await page.locator('[data-picker-probe="ready"]').waitFor({ state: "visible", timeout: 30_000 });

    /* ---- 1. STARTUP: trigger click → a list with rows on screen. ------------------------------
     *
     * Measured in the page, from the click to the first frame that has painted rows, so it includes
     * decoding the index, filtering it, and mounting the window — and excludes Playwright's own
     * round trips, which would otherwise be most of the number.
     */
    const startup = await page.evaluate(async () => {
      const trigger = document.querySelector<HTMLButtonElement>('[data-testid="font-picker-trigger"]')!;
      const started = performance.now();
      trigger.click();
      // Two frames: one for React to commit, one for the browser to paint what it committed.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return performance.now() - started;
    });

    const list = page.locator('[data-testid="font-picker-list"]');
    await list.waitFor({ state: "visible", timeout: 10_000 });
    const rowCount = Number(await list.getAttribute("data-row-count"));
    const mounted = await page.locator('[data-testid^="font-option-"]').count();
    process.stdout.write(
      `\nSTARTUP           ${startup.toFixed(1)} ms  (${rowCount.toLocaleString()} rows in the list, ${mounted} mounted)\n`
    );

    // An artifact for human eyes. Every assertion here is about counts and clocks, none of which
    // would notice rows stacked on top of each other by a bad `position: absolute`.
    await page.screenshot({ path: path.join(repoRoot, "tmp", "font-picker", "picker-open.png") });

    /* ---- 2. VIRTUALIZATION, asserted structurally rather than inferred from the clock. -------- */
    assert.ok(
      rowCount > 1000,
      `the list holds ${rowCount} rows. This gate is meant to measure a catalogue, and a short list would ` +
        `post excellent numbers while proving nothing about the one being shipped.`
    );
    assert.ok(
      mounted < 60,
      `${mounted} rows are MOUNTED out of ${rowCount}. The list is not virtualized — and on a fast machine it ` +
        `might still post acceptable frame times while doing it, which is why this is asserted on the DOM and ` +
        `not on the clock.`
    );
    assert.ok(startup < 1500, `picker startup took ${startup.toFixed(0)} ms. Opening a dropdown must not feel like a page load.`);

    /* ---- 3. STEADY-STATE SCROLL. --------------------------------------------------------------
     *
     * A separate number, deliberately. Scrolling re-slices the window and re-mounts rows every frame;
     * startup pays for the index decode once. Reporting one figure for both would let a slow scroll
     * hide behind a fast open.
     *
     * The scroll is driven one frame at a time from inside the page so that each step is followed by
     * a real layout+paint, and the deltas between animation frames are what a user experiences as
     * smooth or not.
     */
    const scroll = await page.evaluate(async () => {
      const element = document.querySelector<HTMLElement>('[data-testid="font-picker-list"]')!;
      const deltas: number[] = [];
      let previous = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
      for (let step = 0; step < 120; step += 1) {
        element.scrollTop += 90;
        const now = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
        deltas.push(now - previous);
        previous = now;
      }
      return { deltas, finalScrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
    });

    const median = percentile(scroll.deltas, 0.5);
    const p95 = percentile(scroll.deltas, 0.95);
    const worst = Math.max(...scroll.deltas);
    process.stdout.write(
      `SCROLL (120 frames) median ${median.toFixed(1)} ms   p95 ${p95.toFixed(1)} ms   worst ${worst.toFixed(1)} ms\n`
    );
    process.stdout.write(`                    travelled ${scroll.finalScrollTop} of ${scroll.scrollHeight} px\n`);

    assert.ok(
      scroll.finalScrollTop > 5000,
      `the list barely moved (${scroll.finalScrollTop} px). The frame times above describe a stationary list ` +
        `and prove nothing — the measurement is VOID, not fast.`
    );
    // 20 ms median leaves headroom over a 16.7 ms frame without demanding a quiet machine. The p95
    // bar is what catches a list that hitches periodically rather than one that is uniformly slow.
    assert.ok(median < 20, `median frame ${median.toFixed(1)} ms while scrolling — the list is dropping frames continuously.`);
    assert.ok(p95 < 50, `p95 frame ${p95.toFixed(1)} ms — the scroll hitches, which is what "laggy" actually feels like.`);

    // Rows must still be a window AFTER scrolling: a list that mounts as it goes and never unmounts
    // is virtualized at startup and unvirtualized by the time anyone has used it.
    const mountedAfter = await page.locator('[data-testid^="font-option-"]').count();
    process.stdout.write(`mounted after scrolling: ${mountedAfter}\n`);
    assert.ok(mountedAfter < 60, `${mountedAfter} rows mounted after scrolling — the window grows instead of moving.`);

    /* ---- 4. The script filter, which is where this stage meets S0b/S0c. ----------------------- */
    await page.locator('[data-testid="font-script-arabic"]').click();
    await page.waitForTimeout(200);
    const arabicRows = Number(await list.getAttribute("data-row-count"));
    process.stdout.write(`arabic filter: ${arabicRows} rows (from ${rowCount})\n`);
    assert.ok(arabicRows > 10, `the Arabic filter left ${arabicRows} rows — a chip that empties the list tells the user we have none.`);
    assert.ok(arabicRows < rowCount / 4, "…and it must actually NARROW, or it is not a filter.");
    // The picture worth keeping: Arabic families, each row set in its own face, each sampled with
    // Arabic text rather than "Ag". This is what makes S0b/S0c's base-direction work reachable.
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(repoRoot, "tmp", "font-picker", "picker-arabic.png") });

    /**
     * Rows the user has LANDED on must load, and this is a regression assertion rather than a
     * precaution: two versions of the loader passed every timing bar above while leaving the visible
     * rows blank. First the queue drained oldest-first, so families scrolled past were served ahead
     * of the ones on screen; then a re-request could not raise a queued family's priority, so the
     * fix did not reach the case that mattered. Both were found by LOOKING at the picker — the clock
     * had nothing to say about either.
     */
    const arabicReady = await page
      .locator('[data-testid^="font-option-"][data-preview-ready="true"]')
      .count();
    const arabicMounted = await page.locator('[data-testid^="font-option-"]').count();
    process.stdout.write(`arabic rows with their own face: ${arabicReady}/${arabicMounted}\n`);
    assert.ok(
      arabicReady >= Math.ceil(arabicMounted / 2),
      `only ${arabicReady} of ${arabicMounted} visible Arabic rows loaded a face after 4s. A list of names in the ` +
        `UI font is the thing this stage exists to avoid, and every timing bar above passes while it happens.`
    );

    /* ---- 5. THE ONE WRITE. -------------------------------------------------------------------- */
    await page.locator('[data-testid="font-script-all"]').click();
    await page.locator('[data-testid="font-picker-search"]').fill("Anton");
    await page.waitForTimeout(200);
    await page.locator('[data-testid="font-option-Anton"]').click();
    await page.waitForTimeout(500);
    const picked = await page.locator("[data-picked-ref]").getAttribute("data-picked-ref");
    assert.ok(picked, "picking a font wrote NO ref at all.");
    const ref = JSON.parse(picked) as { source: string; family: string; fileHash: string };
    process.stdout.write(`picked: ${ref.family} → ${ref.source}/${ref.fileHash.slice(0, 12)}…\n`);
    assert.equal(ref.source, "catalogue");
    assert.equal(ref.family, "Anton");
    assert.equal(
      ref.fileHash,
      "a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab",
      "a pick must write the fileHash of the actual file. Everything S2 built — the mirror, the install path, " +
        "the named abort — is downstream of this one field, and a picker that omitted it would look identical."
    );

    process.stdout.write(`\nPASS — ${rowCount.toLocaleString()} rows, ${mounted} mounted, ${startup.toFixed(0)} ms to open, ${median.toFixed(1)} ms median frame.\n`);
  } finally {
    await browser.close();
    stopWebServer(vite);
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
