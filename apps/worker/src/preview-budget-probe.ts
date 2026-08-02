/**
 * Preview FRAME BUDGET probe — the soak reading that only a human could produce, scripted.
 *
 * WHY. The ADR-012 Phase 3 soak turned up one defect no headless gate could see: with
 * `?kernelProxySource=1` the picture was correct (no flashes, no blacks, every pixel gate green) and the
 * preview fell from ~75fps to 48-59 with intermittent lag. Every correctness gate in this repo passes on
 * that build, because the defect was never in the output — it was in the cost of producing it.
 *
 * That reading was obtained by a person opening the editor, playing, and reading the HUD. Doing it by
 * hand cost hours and produced arms that were not comparable: different projects, unequal durations, one
 * run missing its telemetry snippet. None of that is inherent — `__rfFrameStats` is the same object the
 * HUD renders, and engine flags are URL parameters, so the controlled A/B is two `page.goto` calls.
 *
 * WHAT IT REPORTS, per arm: fps / mean frame ms / composite CPU ms / dropped-frame counts from
 * `__rfFrameStats`, alongside `__rfWcPool` (decoder sessions, retention hits) and `__rfKernelState`
 * (declared / demoted / suppressed sources, decoder ledger, resource scopes). Frame budget and resource
 * ledger in one table, because "it got slower" and "it is holding more sessions" are the two halves of
 * every finding this programme has produced.
 *
 * This is a MEASUREMENT harness, not a pass/fail gate. Absolute numbers are machine-specific; the arms
 * are comparable to each other on one box in one run, which is the only comparison anyone should make.
 *
 * A blank project seeded with one clip has NO Flarex comp, so `kernelProxySource` has nothing to demote
 * and both arms should read the same — that is the harness's own null result, and worth having: an arm
 * difference on a comp-free project would mean the flag costs something unconditionally. To measure the
 * demotion path itself, point this at a project that HAS a proxied comp:
 *
 *   PROBE_PROJECT=http://localhost:5173/editor/<id> PIXEL_BROWSER_CHANNEL=chrome \
 *     pnpm --filter @orreris/worker preview:budget
 *
 * Local projects live in the browser profile, so a saved profile is needed to see one again:
 *   PROBE_PROFILE=<dir>   reuse/persist a Chrome profile between runs
 *
 * Run (dev server must be up):
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker preview:budget
 *   PROBE_SECONDS=20 ...   (default 12 of playback per arm)
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import { reachEditor, reopenWithFlags, EDITOR_BASE } from "./browser/editor-session";

const SECONDS = Number(process.env.PROBE_SECONDS ?? 12);
/** Discarded before sampling: the first second of playback is decoder warmup, not steady state. */
const WARMUP_MS = 1_500;

/** The arms. Equal durations, same project, same page — the three things the hand-run soak could not hold. */
const ARMS: { name: string; flags: string }[] = [
  { name: "baseline (proxy source OFF)", flags: "kernelProxySource=0" },
  { name: "S3.5 demotion (proxy source ON)", flags: "kernelProxySource=1" },
];

interface Sample {
  /** Compositor repaint rate — runs at display refresh and will happily redraw an unchanged frame. */
  fps: number;
  /**
   * NEW video frames presented per second. Sampled alongside `fps` because they answer different
   * questions and this repo has already confused them once: a demoted loader that stopped pulling
   * SHOULD drop `mediaFps` for its own sources while leaving the compositor's `fps` alone, so reporting
   * only one of the two would make the intended effect indistinguishable from the defect.
   */
  mediaFps: number;
  avgFrameMs: number;
  maxFrameMs: number;
  drawMs: number;
  droppedRatio: number;
  severeCount: number;
  renderScale: number;
}

interface ArmResult {
  name: string;
  samples: Sample[];
  pool: Record<string, number> | null;
  kernel: unknown;
  degradation: unknown;
  error?: string;
}

// Targeted by `title`, not by role name: the transport button's content is an icon, so its computed
// accessible name is the glyph and `getByRole("button", { name: /play/i })` silently matches nothing —
// which is how the first run of this probe reported "transport never advanced" for both arms while the
// editor was in fact fine. The title is also the toggle's state (`Play (Space)` / `Pause (Space)`), so
// it doubles as the assertion that the click landed.
// Scoped to `.viewer-controls`: `button[title^="Play"]` matches TWO controls — the viewer transport and
// the inspector's reverse-play — and DOM order puts the wrong one first, so an unscoped `.first()` clicks
// a control that does nothing here and reports "the transport never advanced".
const PLAY = '.viewer-controls button[title^="Play"]';
const PAUSE = '.viewer-controls button[title^="Pause"]';

async function play(page: Page): Promise<boolean> {
  const button = page.locator(PLAY).first();
  if (!(await button.count().catch(() => 0))) return false;
  await button.click().catch(() => undefined);
  // The toggle flipping to "Pause" is the only proof the transport actually started.
  return await page
    .locator(PAUSE)
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
}

async function pause(page: Page): Promise<void> {
  await page.locator(PAUSE).first().click({ timeout: 3_000 }).catch(() => undefined);
}

async function sampleArm(page: Page, name: string): Promise<ArmResult> {
  const samples: Sample[] = [];
  if (!(await play(page))) {
    return {
      name,
      samples,
      pool: null,
      kernel: null,
      degradation: null,
      error: `transport did not start (no ${PLAY}, or it never flipped to Pause)`,
    };
  }
  await page.waitForTimeout(WARMUP_MS);

  const deadline = Date.now() + SECONDS * 1_000;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const stats = (globalThis as Record<string, any>).__rfFrameStats;
      if (!stats) return null;
      return {
        fps: Number(stats.fps ?? 0),
        mediaFps: Number(stats.mediaFps ?? 0),
        avgFrameMs: Number(stats.avgFrameMs ?? 0),
        maxFrameMs: Number(stats.maxFrameMs ?? 0),
        drawMs: Number(stats.avgDrawMs ?? 0),
        droppedRatio: Number(stats.droppedRatio ?? 0),
        severeCount: Number(stats.severeCount ?? 0),
        renderScale: Number(stats.renderScale ?? 1),
      };
    });
    // Idle samples (fps 0) are not slow frames — they are the absence of frames, and averaging them in
    // would make a paused arm look catastrophic rather than absent.
    if (snap && snap.fps > 0) samples.push(snap);
    await page.waitForTimeout(250);
  }

  const tail = await page.evaluate(() => ({
    pool: (globalThis as Record<string, any>).__rfWcPool ?? null,
    kernel: (globalThis as Record<string, any>).__rfKernelState ?? null,
    degradation: (globalThis as Record<string, any>).__rfFlarexDegradation ?? null,
  }));
  await pause(page);
  return { name, samples, ...tail };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function report(result: ArmResult): void {
  console.log(`\n── ${result.name}`);
  if (result.error) {
    console.log(`   ERROR: ${result.error}`);
    return;
  }
  if (result.samples.length === 0) {
    console.log("   no frames sampled (transport never advanced)");
    return;
  }
  const fps = result.samples.map((s) => s.fps);
  const mediaFps = result.samples.map((s) => s.mediaFps);
  const frameMs = result.samples.map((s) => s.avgFrameMs);
  const drawMs = result.samples.map((s) => s.drawMs);
  const last = result.samples[result.samples.length - 1]!;
  console.log(
    `   fps       p50 ${percentile(fps, 50).toFixed(1)}   p05 ${percentile(fps, 5).toFixed(1)} (worst)   ` +
      `min ${Math.min(...fps).toFixed(1)}   samples ${result.samples.length}   renderScale ${last.renderScale}`
  );
  console.log(`   mediaFps  p50 ${percentile(mediaFps, 50).toFixed(1)}   p05 ${percentile(mediaFps, 5).toFixed(1)}`);
  console.log(`   frame ms  p50 ${percentile(frameMs, 50).toFixed(2)}   p95 ${percentile(frameMs, 95).toFixed(2)}   worst ${Math.max(...result.samples.map((s) => s.maxFrameMs)).toFixed(1)}`);
  console.log(`   draw ms   p50 ${percentile(drawMs, 50).toFixed(2)}   p95 ${percentile(drawMs, 95).toFixed(2)}`);
  console.log(
    `   dropped   ${(percentile(result.samples.map((s) => s.droppedRatio), 50) * 100).toFixed(1)}% of frames   ` +
      `severe ${Math.max(...result.samples.map((s) => s.severeCount))}`
  );
  const pool = result.pool;
  if (pool) {
    console.log(
      `   decoder  created ${pool.created} · active ${pool.active} (preload ${pool.activePreload}) · idle ${pool.idle} · ` +
        `retained ${pool.retainedIdle} · retention hits ${pool.retentionHits}/${pool.retentions} · capMisses ${pool.capMisses}`
    );
  }
  const kernel = result.kernel as { media?: Record<string, unknown>; decoder?: Record<string, unknown> } | null;
  if (kernel?.media) {
    const media = kernel.media as Record<string, any>;
    console.log(
      `   media    declared ${media.declared} · active ${media.active} · ` +
        `demoted ${media.demoted?.length ?? 0} · suppressed ${media.suppressed?.length ?? 0}`
    );
  }
  if (kernel?.decoder) {
    const dec = kernel.decoder as Record<string, any>;
    console.log(
      `   sessions open ${dec.openCount ?? "?"} · held ${dec.held?.length ?? 0} · orphaned ${dec.orphaned?.length ?? 0} · unmet ${dec.unmet?.length ?? 0}`
    );
  }
  const deg = result.degradation as { substitutedTotal?: number; byReason?: { reason: string; count: number }[] } | null;
  if (deg && (deg.substitutedTotal ?? 0) >= 0 && deg.byReason?.length) {
    console.log(
      `   degrade  substituted ${deg.substitutedTotal} · ${deg.byReason.slice(0, 3).map((r) => `${r.reason} ${r.count}`).join(" · ")}`
    );
  }
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const profile = process.env.PROBE_PROFILE;
  let context: BrowserContext;
  if (profile) {
    context = await chromium.launchPersistentContext(profile, {
      ...(channel ? { channel } : {}),
      viewport: { width: 1600, height: 900 },
    });
  } else {
    const browser = await chromium.launch(channel ? { channel } : {});
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  const explicit = process.env.PROBE_PROJECT;
  let projectUrl: string;
  if (explicit) {
    await page.goto(explicit, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6_000);
    projectUrl = page.url();
  } else {
    projectUrl = await reachEditor(page);
  }
  if (!projectUrl.includes("/editor/")) {
    throw new Error(`not in the editor: ${projectUrl}`);
  }
  console.log(`project: ${projectUrl}`);
  console.log(`arms: ${ARMS.length} × ${SECONDS}s of playback (after ${WARMUP_MS}ms warmup), same page, same project`);

  const results: ArmResult[] = [];
  for (const arm of ARMS) {
    // Progress on stdout as it happens. A probe that drives a browser for minutes and prints only at
    // the end is indistinguishable from a hung one, which cost a debugging round the first time.
    console.log(`  · ${arm.name}: reloading with ?${arm.flags}`);
    await reopenWithFlags(page, projectUrl, arm.flags);
    console.log(`  · ${arm.name}: playing ${SECONDS}s`);
    results.push(await sampleArm(page, `${arm.name}   [?${arm.flags}]`));
    console.log(`  · ${arm.name}: done`);
  }

  console.log("\n════ frame budget ════");
  for (const result of results) report(result);

  const [a, b] = results;
  if (a && b && a.samples.length > 0 && b.samples.length > 0) {
    const fpsA = percentile(a.samples.map((s) => s.fps), 50);
    const fpsB = percentile(b.samples.map((s) => s.fps), 50);
    const delta = fpsB - fpsA;
    console.log(
      `\n[budget] p50 fps  baseline ${fpsA.toFixed(1)} → demotion ${fpsB.toFixed(1)}  ` +
        `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)}, ${((delta / fpsA) * 100).toFixed(1)}%)`
    );
    // No assertion: on a comp-free project there is nothing to demote and parity is the expected result,
    // so a threshold here would only ever fire on noise. The number is the deliverable.
  }
  if (errors.length) console.log(`\nconsole errors (${errors.length}):\n${errors.slice(0, 5).map((e) => `  ${e}`).join("\n")}`);

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
