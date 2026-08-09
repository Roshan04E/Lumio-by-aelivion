/**
 * MEASUREMENT ONLY — D1-D4, the 4-5s preview delay on a paused ruler seek.
 *
 * SUPERSEDES the X/Y/Z (retention/scaling/path) design this file originally held: the founder ran R1 by
 * hand and found the delay tracks SEEK DISTANCE and POSITION-WITHIN-THE-SOURCE, not clip identity or
 * source count — "different clip" was a proxy for "far away". Working hypothesis: the decode path
 * reaches a target frame by decoding FORWARD from the nearest preceding keyframe (or the current decode
 * position), so cost is proportional to frames-from-keyframe — the classic long-GOP seek signature.
 *
 *   D1. DISTANCE SWEEP — single clip, paused, settled. Seek +0.5s / +2s / +10s / +30s from a fixed start
 *       and measure time-to-picture for each. Monotonic in distance?
 *   D2. POSITION SWEEP — from a COLD, RELOADED, settled state each time, seek directly to t≈1s, then
 *       (fresh reload) t≈30s, then (fresh reload) t≈60s. Separates "distance from current decode
 *       position" (D1) from "distance from the preceding keyframe" (D2+D3).
 *   D3. THE SOURCE'S OWN KEYFRAME STRUCTURE — ffprobe, not inferred.
 *   D4. PATH — __rfWcMode / __rfRouting for the source during a slow seek, and proxy state
 *       (window.__rfSourceProxy) asserted stable across each sweep (a build completing mid-sweep would
 *       move the numbers under us — proxy builds suspend during PLAYBACK but this project stays paused
 *       throughout, so a build can legitimately progress in the background here).
 *
 * PRECONDITIONS: PIXEL_BROWSER_CHANNEL=chrome (refused otherwise). awaitWebCodecsEngaged before the
 * first measured seek — with a SINGLE source on the timeline there is no "which source" ambiguity, so
 * this is not the circular precondition that voided the starvation census (that trap is about requiring
 * a LATER, not-yet-mounted source to have already engaged). Machine state (free RAM, chrome/node process
 * counts) reported immediately before the run.
 *
 * INSTRUMENT: canvas pixel-hash sampling (24x24 offscreen 2D canvas, ~0.1ms/sample — same technique and
 * documented cost as preview-freeze-probe.ts), from the click to the hash settling. Never inferred from
 * an internal "ready" signal.
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker rulerjump:probe
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { awaitWebCodecsEngaged, defaultClipPath, reachEditor } from "./browser/editor-session";

function reportMachineState(): void {
  const freeGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  const totalGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  let chromeCount = "?";
  let nodeCount = "?";
  try {
    const out = execSync("tasklist", { encoding: "utf8" });
    chromeCount = String((out.match(/chrome\.exe/gi) ?? []).length);
    nodeCount = String((out.match(/node\.exe/gi) ?? []).length);
  } catch {
    /* best effort */
  }
  console.log(`machine state: free ${freeGB}GB / ${totalGB}GB total, chrome.exe x${chromeCount}, node.exe x${nodeCount}`);
}

/** D3: the source's own keyframe structure, via ffprobe — not inferred from app behavior. */
function probeKeyframes(clipPath: string): { timesSeconds: number[]; gopSeconds: number | null } {
  const out = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries frame=pict_type,pts_time -of csv=p=0 "${clipPath}"`,
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const times: number[] = [];
  for (const line of out.split("\n")) {
    const [ptsTime, type] = line.split(",");
    if (type?.trim() === "I" && ptsTime) times.push(Number(ptsTime));
  }
  if (times.length < 2) return { timesSeconds: times, gopSeconds: null };
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
  return { timesSeconds: times, gopSeconds: median };
}

function distanceToPrecedingKeyframe(keyframes: number[], seconds: number): number {
  let preceding = 0;
  for (const k of keyframes) {
    if (k <= seconds) preceding = k;
    else break;
  }
  return seconds - preceding;
}

async function calibrateRuler(page: Page): Promise<{ rulerY: number; rulerLeft: number; rulerRight: number; pxPerSec: number } | null> {
  const geometry = await page.evaluate(() => {
    const ruler = document.querySelector(".timeline-ruler");
    if (!(ruler instanceof HTMLElement)) return null;
    const r = ruler.getBoundingClientRect();
    return { rulerY: r.top + r.height / 2, rulerLeft: r.left, rulerRight: r.right };
  });
  if (!geometry) return null;
  const clickAt = async (x: number): Promise<number | null> => {
    await page.mouse.click(x, geometry.rulerY);
    await page.waitForTimeout(200);
    return page.evaluate(() => (window as unknown as { __rfClock?: { committed: number } }).__rfClock?.committed ?? null);
  };
  const refX = geometry.rulerLeft + 40;
  const cutX = geometry.rulerLeft + 240;
  const t1 = await clickAt(refX);
  const t2 = await clickAt(cutX);
  if (t1 == null || t2 == null || t2 <= t1) return null;
  return { rulerY: geometry.rulerY, rulerLeft: geometry.rulerLeft, rulerRight: geometry.rulerRight, pxPerSec: (cutX - refX) / (t2 - t1) };
}

async function seekToSeconds(page: Page, cal: NonNullable<Awaited<ReturnType<typeof calibrateRuler>>>, seconds: number): Promise<void> {
  const targetX = cal.rulerLeft + 40 + seconds * cal.pxPerSec;
  const clamped = Math.min(cal.rulerRight - 4, Math.max(cal.rulerLeft + 4, targetX));
  await page.mouse.click(clamped, cal.rulerY);
}

async function installPixelProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __jumpProbe?: { hash: () => number | null } };
    if (w.__jumpProbe) return;
    const probe = document.createElement("canvas");
    probe.width = 24;
    probe.height = 24;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    const findCanvas = (): HTMLCanvasElement | null => {
      const list = document.querySelectorAll("canvas");
      let best: HTMLCanvasElement | null = null;
      for (const c of Array.from(list) as HTMLCanvasElement[]) {
        if (c === probe) continue;
        if (!best || c.width * c.height > best.width * best.height) best = c;
      }
      return best;
    };
    w.__jumpProbe = {
      hash(): number | null {
        const c = findCanvas();
        if (!c || !pctx || c.width === 0) return null;
        try {
          pctx.drawImage(c, 0, 0, 24, 24);
          const d = pctx.getImageData(0, 0, 24, 24).data;
          let h = 0;
          for (let i = 0; i < d.length; i += 4) {
            h = (h * 31 + d[i]!) | 0;
            h = (h * 31 + d[i + 1]!) | 0;
            h = (h * 31 + d[i + 2]!) | 0;
          }
          return h;
        } catch {
          return null;
        }
      },
    };
  });
}

interface JumpResult {
  label: string;
  msToFirstChange: number | null;
  msToSettle: number | null;
  timedOut: boolean;
}

/** Poll the pixel hash until it stops changing for `stableMs`, WITHOUT clicking anything. Used before a
 *  timed measurement so the "before" state is a confirmed-settled picture, not an assumed one — the gap
 *  a fixed sleep leaves open (a reset-seek or a page reload might not actually be done rendering yet). */
async function waitForPictureStable(page: Page, timeoutMs = 15_000, stableMs = 500): Promise<{ settled: boolean; ms: number }> {
  const started = Date.now();
  let lastHash = await page.evaluate(() => (window as unknown as { __jumpProbe: { hash: () => number | null } }).__jumpProbe.hash());
  let lastChangeAt = started;
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(100);
    const h = await page.evaluate(() => (window as unknown as { __jumpProbe: { hash: () => number | null } }).__jumpProbe.hash());
    const now = Date.now();
    if (h !== lastHash) {
      lastHash = h;
      lastChangeAt = now;
    } else if (now - lastChangeAt >= stableMs) {
      return { settled: true, ms: now - started };
    }
  }
  return { settled: false, ms: Date.now() - started };
}

async function measureJump(page: Page, cal: NonNullable<Awaited<ReturnType<typeof calibrateRuler>>>, seconds: number, label: string, timeoutMs = 20_000, stableMs = 400): Promise<JumpResult> {
  const before = await page.evaluate(() => (window as unknown as { __jumpProbe: { hash: () => number | null } }).__jumpProbe.hash());
  await seekToSeconds(page, cal, seconds);
  const clickedAt = Date.now();

  let firstChangeAt: number | null = null;
  let lastHash = before;
  let lastChangeAt = clickedAt;
  while (Date.now() - clickedAt < timeoutMs) {
    const h = await page.evaluate(() => (window as unknown as { __jumpProbe: { hash: () => number | null } }).__jumpProbe.hash());
    const now = Date.now();
    if (h !== lastHash) {
      if (firstChangeAt === null) firstChangeAt = now;
      lastHash = h;
      lastChangeAt = now;
    } else if (firstChangeAt !== null && now - lastChangeAt >= stableMs) {
      return { label, msToFirstChange: firstChangeAt - clickedAt, msToSettle: now - clickedAt, timedOut: false };
    }
    await page.waitForTimeout(80);
  }
  return { label, msToFirstChange: firstChangeAt === null ? null : firstChangeAt - clickedAt, msToSettle: null, timedOut: true };
}

async function readWcModes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfWcMode ?? {}) }));
}

async function readProxyStats(page: Page) {
  return page.evaluate(() => {
    const s = (globalThis as Record<string, any>).__rfSourceProxy ?? {};
    return {
      built: Number(s.built ?? 0),
      failed: Number(s.failed ?? 0),
      skipped: Number(s.skipped ?? 0),
      queued: Number(s.queued ?? 0),
      active: (s.active ?? null) as string | null,
      recentCount: Array.isArray(s.recent) ? s.recent.length : 0,
    };
  });
}

/** WebCodecs engagement is gated on either a dense-GOP measurement or the ingest proxy landing
 *  (source-proxy system + WebglMediaLayer's `preferNativeDecode`). This seed clip's GOP is sparse
 *  (~8.3s, per D3) so the proxy is the only path in — a long clip's first-ever transcode can take
 *  well past awaitWebCodecsEngaged's default 60s on anything but an idle machine. Waits for the build
 *  to actually finish (or fail/skip) rather than assuming a fixed timeout is enough; reports how long
 *  it took, which is itself a real "cold cost" data point for D4. */
async function waitForProxyBuild(page: Page, timeoutMs = 240_000): Promise<{ finished: boolean; ms: number; outcome: string }> {
  const started = Date.now();
  const before = await readProxyStats(page);
  while (Date.now() - started < timeoutMs) {
    const now = await readProxyStats(page);
    if (now.built > before.built) return { finished: true, ms: Date.now() - started, outcome: "built" };
    if (now.failed > before.failed) return { finished: true, ms: Date.now() - started, outcome: "failed" };
    if (now.skipped > before.skipped) return { finished: true, ms: Date.now() - started, outcome: "skipped" };
    await page.waitForTimeout(1_000);
  }
  return { finished: false, ms: Date.now() - started, outcome: "timeout" };
}

async function readRouting(page: Page): Promise<Record<string, unknown[]>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfRouting ?? {}) }));
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (channel !== "chrome") {
    console.log("REFUSING — PIXEL_BROWSER_CHANNEL=chrome is required (SwiftShader ~8fps voids this).");
    process.exit(1);
  }
  reportMachineState();

  const clip = defaultClipPath(Number(process.env.PROBE_MIN_SECONDS ?? 140));
  console.log(`seed clip: ${clip}`);
  const keyframes = probeKeyframes(clip);
  console.log(`\n── D3: keyframe structure (ffprobe) ──`);
  console.log(`  keyframe count: ${keyframes.timesSeconds.length}`);
  console.log(`  keyframe times: ${keyframes.timesSeconds.map((t) => t.toFixed(2)).join(", ")}`);
  console.log(`  median GOP interval: ${keyframes.gopSeconds?.toFixed(3) ?? "n/a"}s`);

  let browser: Browser | null = null;
  let context: BrowserContext;
  if (process.env.PROBE_PROFILE) {
    context = await chromium.launchPersistentContext(process.env.PROBE_PROFILE, { channel, viewport: { width: 1600, height: 900 } });
  } else {
    browser = await chromium.launch({ channel });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  // esbuild/vite dev helper shim, matching every sibling probe (flarex-cache-gate.ts etc.) — without
  // this, page.evaluate throws "__name is not defined" the moment vite's dev transform touches a
  // function expression inside the injected script.
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");

  try {
    const projectUrl = await reachEditor(page, { clipPath: clip, flags: "wcDecode=1&kernelDiagnostics=1" });
    console.log(`\nproject: ${projectUrl}`);

    // This seed clip's GOP is sparse (D3: ~8.3s), so WebCodecs engagement is gated on the ingest proxy
    // landing — a first-ever transcode of a 145s file, not instant. Wait for it explicitly rather than
    // assuming awaitWebCodecsEngaged's default 60s covers it.
    const proxyBuild = await waitForProxyBuild(page);
    console.log(`proxy build: ${proxyBuild.outcome} after ${proxyBuild.ms}ms${proxyBuild.finished ? "" : " (timed out waiting)"}`);

    const engaged = await awaitWebCodecsEngaged(page, 60_000);
    console.log(`awaitWebCodecsEngaged: ${engaged ? "engaged" : "TIMED OUT — treat this run as VOID for anything below"}`);
    if (!engaged) {
      console.log("VOID — WebCodecs never engaged before the first measured seek. Stopping.");
      return;
    }

    await installPixelProbe(page);
    let cal = await calibrateRuler(page);
    if (!cal) {
      console.log("VOID — could not calibrate the ruler.");
      return;
    }

    const proxyBefore = await readProxyStats(page);
    console.log(`\nproxy state at start: built=${proxyBefore.built} active=${proxyBefore.active} queued=${proxyBefore.queued} skipped=${proxyBefore.skipped} recent=${proxyBefore.recentCount}`);

    // ── D1: DISTANCE SWEEP — same start, increasing distance. ──────────────────────────────
    console.log(`\n── D1: DISTANCE SWEEP (from t≈2s, paused) ──`);
    await seekToSeconds(page, cal, 2);
    const initialSettle = await waitForPictureStable(page);
    console.log(`  initial settle at t≈2s: ${initialSettle.settled ? `confirmed after ${initialSettle.ms}ms` : "TIMED OUT — starting anyway, flagged"}`);
    const d1Start = 2;
    const d1Distances = [0.5, 2, 10, 30];
    const d1Results: Array<JumpResult & { distanceSeconds: number; distanceToKeyframe: number; resetConfirmedSettled: boolean }> = [];
    let cursor = d1Start;
    let resetConfirmedSettled = initialSettle.settled;
    for (const dist of d1Distances) {
      const target = cursor + dist;
      const r = await measureJump(page, cal, target, `D1 +${dist}s (t=${cursor.toFixed(1)}→${target.toFixed(1)})`);
      const dtk = distanceToPrecedingKeyframe(keyframes.timesSeconds, target);
      d1Results.push({ ...r, distanceSeconds: dist, distanceToKeyframe: dtk, resetConfirmedSettled });
      console.log(`  ${r.label}: firstChange=${r.msToFirstChange}ms settle=${r.msToSettle}ms timedOut=${r.timedOut}  distToKeyframe=${dtk.toFixed(2)}s  startedFromConfirmedSettle=${resetConfirmedSettled}`);
      // Reset back near the same start for the NEXT distance — and CONFIRM it actually settled before
      // starting the next timed measurement, rather than assuming a fixed sleep was enough. A reset
      // that hasn't finished rendering yet would silently pollute the next measurement's "before" state.
      await seekToSeconds(page, cal, d1Start);
      const resetSettle = await waitForPictureStable(page);
      resetConfirmedSettled = resetSettle.settled;
      cursor = d1Start;
    }
    const proxyAfterD1 = await readProxyStats(page);
    console.log(`proxy state after D1: built=${proxyAfterD1.built} active=${proxyAfterD1.active} queued=${proxyAfterD1.queued} recent=${proxyAfterD1.recentCount}`);
    const d1ProxyStable = proxyAfterD1.built === proxyBefore.built && proxyAfterD1.recentCount === proxyBefore.recentCount;
    console.log(`D1 proxy state stable across the sweep: ${d1ProxyStable}${d1ProxyStable ? "" : " — ⚠ VOID risk, a build completed mid-sweep"}`);

    console.log(`\nD1 summary (distance, ms to settle, dist-to-keyframe):`);
    for (const r of d1Results) console.log(`  +${r.distanceSeconds}s: settle=${r.msToSettle}ms  distToKeyframe=${r.distanceToKeyframe.toFixed(2)}s`);
    const settled = d1Results.filter((r) => r.msToSettle != null);
    const monotonic = settled.every((r, i) => i === 0 || r.msToSettle! >= settled[i - 1]!.msToSettle! - 50);
    console.log(`D1 monotonic in distance (±50ms tolerance): ${monotonic}`);

    // ── D2: POSITION SWEEP — fresh reload before EACH point, so distance-traveled is not confounded
    // with absolute position (each seek is the FIRST and ONLY seek since that reload). ──────────────
    console.log(`\n── D2: POSITION SWEEP (fresh reload before each point) ──`);
    const d2Points = [1, 30, 60];
    const d2Results: Array<JumpResult & { positionSeconds: number; distanceToKeyframe: number; mountSettleMs: number | null }> = [];
    const proxyDuringD2: Array<ReturnType<typeof readProxyStats> extends Promise<infer T> ? T : never> = [];
    for (const pos of d2Points) {
      await page.goto(projectUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      const engagedAgain = await awaitWebCodecsEngaged(page);
      await installPixelProbe(page);
      if (!engagedAgain) {
        console.log(`  t≈${pos}s: VOID — WebCodecs did not re-engage after reload`);
        continue;
      }
      // CONFIRM the initial mount (at t≈0) has actually settled BEFORE calibrating or measuring — a
      // fixed sleep here would let "still loading the first frame" leak into the measured seek time,
      // exactly the observer-effect risk the founder's D2 design is meant to isolate against.
      const mountSettle = await waitForPictureStable(page);
      if (!mountSettle.settled) {
        console.log(`  t≈${pos}s: mount never settled within timeout — measuring anyway, flagged`);
      }
      const cal2 = await calibrateRuler(page);
      if (!cal2) {
        console.log(`  t≈${pos}s: VOID — ruler calibration failed after reload`);
        continue;
      }
      const proxyNow = await readProxyStats(page);
      proxyDuringD2.push(proxyNow);
      const r = await measureJump(page, cal2, pos, `D2 fresh→t=${pos}s`);
      const dtk = distanceToPrecedingKeyframe(keyframes.timesSeconds, pos);
      d2Results.push({ ...r, positionSeconds: pos, distanceToKeyframe: dtk, mountSettleMs: mountSettle.settled ? mountSettle.ms : null });
      console.log(`  ${r.label}: firstChange=${r.msToFirstChange}ms settle=${r.msToSettle}ms timedOut=${r.timedOut}  distToKeyframe=${dtk.toFixed(2)}s  mountSettleMs=${mountSettle.ms}  proxy(built=${proxyNow.built} active=${proxyNow.active})`);
    }
    const proxyStableAcrossD2 = proxyDuringD2.every((p) => p.built === proxyDuringD2[0]?.built);
    console.log(`D2 proxy 'built' count stable across all three reloads: ${proxyStableAcrossD2}${proxyStableAcrossD2 ? "" : " — ⚠ VOID risk"}`);

    console.log(`\nD2 summary (absolute position, ms to settle, dist-to-keyframe, mount-settle for context):`);
    for (const r of d2Results) console.log(`  t≈${r.positionSeconds}s: settle=${r.msToSettle}ms  distToKeyframe=${r.distanceToKeyframe.toFixed(2)}s  mountSettleMs=${r.mountSettleMs}`);

    // ── D4: PATH, sampled at the LAST slow jump measured. ───────────────────────────────────
    console.log(`\n── D4: PATH (decode mode / routing at end of run) ──`);
    const modes = await readWcModes(page);
    const routing = await readRouting(page);
    console.log(`  __rfWcMode: ${JSON.stringify(modes)}`);
    console.log(`  __rfRouting keys: ${Object.keys(routing).join(", ") || "(none)"}`);
    const finalProxy = await readProxyStats(page);
    console.log(`  final proxy state: built=${finalProxy.built} active=${finalProxy.active} queued=${finalProxy.queued} skipped=${finalProxy.skipped}`);

    console.log(`\n(Report D1, D2, D3, D4 separately — do not collapse into one verdict.)\n`);
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

const exitTimer = setTimeout(() => process.exit(0), 10 * 60_000);
exitTimer.unref();

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
