/**
 * Preview CPU PROFILE — where the frame budget actually goes, by name, with numbers.
 *
 * WHY THIS EXISTS. The HUD says the shape of the problem but not its cause:
 *
 *     FPS 37 · Media 84 · Dropped 52% · Frame 26.8ms · Composite 3.0ms · Res 1/4
 *
 * Composite is 3ms and the GPU is ~4.5ms, so roughly TWO THIRDS of every frame is spent somewhere
 * that is neither the compositor nor the GPU. Every instrument this repo already has measures the
 * parts we thought to instrument — `__rfFrameStats`, the frame profiler, the degradation sink — and
 * the missing time is by definition in the part nobody instrumented. No amount of adding counters to
 * suspected code finds it; that is guessing with extra steps.
 *
 * V8's sampling profiler has no such blind spot. It samples the whole stack on a timer, so the answer
 * comes back ranked by SELF TIME whether or not anyone predicted the culprit — including time in React
 * internals, decode callbacks, texture uploads, GC, and the dev-only machinery that a development
 * build inserts into every JSX call.
 *
 * WHAT IT REPORTS. Two tables, both by self time: per FUNCTION and per FILE. The file table is usually
 * the one that names the subsystem; the function table names the line to look at.
 *
 * Run (a server must be up — dev OR a production preview, see below):
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker preview:profile
 *   PROBE_BASE=http://localhost:4173 ...   profile the PRODUCTION build instead of the dev server
 *   PROFILE_SECONDS=15 ...                 (default 10)
 *
 * MEASURE THE BUILD YOU SHIP. A Vite dev server serves `react-dom.development` plus owner-stack
 * instrumentation (`jsx-dev-runtime`, `createTask`, `getTaskName`) on every element creation, and this
 * repo has already lost one perf investigation to exactly that (2026-07-28: the "real cause was the
 * build shipping react-dom.development"). A dev-server profile is still useful — it says how much of
 * the cost is dev-only — but it is not the number a user experiences. Run both and diff them.
 */
import { chromium, type CDPSession, type Page } from "playwright";
import { buildFlarexProxyFixture, defaultClipPath, reachEditor } from "./browser/editor-session";

const SECONDS = Number(process.env.PROFILE_SECONDS ?? 10);
/** 100µs. Fine enough to resolve a 1ms function, cheap enough not to distort a 60fps loop. */
const SAMPLE_INTERVAL_US = 100;
const TOP_N = Number(process.env.PROFILE_TOP ?? 22);

const PLAY = '.viewer-controls button[title^="Play"]';
const PAUSE = '.viewer-controls button[title^="Pause"]';

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}
interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** Collapse a module URL to something a human can scan: the repo-relative path, or the dep name. */
function shortUrl(url: string): string {
  if (!url) return "(native)";
  const withoutQuery = url.split("?")[0] ?? url;
  const deps = /\/(?:node_modules|deps|\.vite)\/(.+)$/.exec(withoutQuery);
  if (deps) return `dep:${deps[1]}`;
  const src = /\/(src\/.+)$/.exec(withoutQuery);
  if (src) return src[1]!;
  const assets = /\/(assets\/[^/]+)$/.exec(withoutQuery);
  if (assets) return `bundle:${assets[1]}`;
  return withoutQuery.replace(/^https?:\/\/[^/]+\//, "");
}

/**
 * Self time per node, in milliseconds.
 *
 * SELF time, not total: a profile ranked by total time always puts the frame loop at the top, which is
 * true and useless. Self time is the only ranking that names the code doing the work.
 */
function selfTimes(profile: CpuProfile): Map<number, number> {
  const byNode = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]!;
    // timeDeltas[i] is the gap BEFORE sample i, which is the interval attributed to it.
    const us = deltas[i] ?? 0;
    byNode.set(id, (byNode.get(id) ?? 0) + us / 1000);
  }
  return byNode;
}

function report(profile: CpuProfile, label: string): void {
  const self = selfTimes(profile);
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const wallMs = (profile.endTime - profile.startTime) / 1000;

  const byFunction = new Map<string, { ms: number; url: string; line: number }>();
  const byFile = new Map<string, number>();
  let total = 0;
  for (const [id, ms] of self) {
    const node = nodes.get(id);
    if (!node) continue;
    total += ms;
    const frame = node.callFrame;
    const file = shortUrl(frame.url);
    const name = frame.functionName || "(anonymous)";
    const key = `${name} · ${file}`;
    const prev = byFunction.get(key);
    if (prev) prev.ms += ms;
    else byFunction.set(key, { ms, url: file, line: frame.lineNumber + 1 });
    byFile.set(file, (byFile.get(file) ?? 0) + ms);
  }

  const pct = (ms: number) => `${((ms / Math.max(total, 1)) * 100).toFixed(1)}%`;
  console.log(`\n════ ${label} ════`);
  console.log(`wall ${wallMs.toFixed(0)}ms · sampled ${total.toFixed(0)}ms of JS (${pct(total)} of samples attributed)`);

  console.log("\n  BY FILE (self time)");
  for (const [file, ms] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N)) {
    console.log(`    ${pct(ms).padStart(6)}  ${(ms.toFixed(0) + "ms").padStart(8)}  ${file}`);
  }

  console.log("\n  BY FUNCTION (self time)");
  for (const [key, entry] of [...byFunction.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, TOP_N)) {
    const [name] = key.split(" · ");
    console.log(`    ${pct(entry.ms).padStart(6)}  ${(entry.ms.toFixed(0) + "ms").padStart(8)}  ${name}  ${entry.url}:${entry.line}`);
  }

  // The dev-build tax, called out by name rather than left for a reader to spot among 22 rows. If this
  // is a large slice, the profile is mostly measuring the development build and the production number
  // is the one that matters (see the header).
  let devOnly = 0;
  for (const [file, ms] of byFile) {
    if (/jsx-dev-runtime|react-dom_client|react-refresh|\bchunk-/.test(file)) devOnly += ms;
  }
  if (devOnly > 0) {
    console.log(`\n  DEV-BUILD MACHINERY: ${pct(devOnly)} (${devOnly.toFixed(0)}ms) in React dev runtime / refresh.`);
    console.log("    A production build does not run this. Re-profile against `vite preview` before acting on the rest.");
  }
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page: Page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  const explicit = process.env.PROBE_PROJECT;
  if (explicit) {
    await page.goto(explicit, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6_000);
  } else {
    await reachEditor(page, { clipPath: defaultClipPath(SECONDS + 8) });
    if (process.env.PROBE_NO_FIXTURE !== "1") {
      console.log("building fixture: Flarex comp + proxy…");
      console.log(`  · ${(await buildFlarexProxyFixture(page)) ? "proxy ready" : "FIXTURE FAILED"}`);
    }
  }
  if (!page.url().includes("/editor/")) throw new Error(`not in the editor: ${page.url()}`);

  // Pin the resolution: Auto adapts the workload to the workload, so an unpinned profile is a profile
  // of the controller as much as of the renderer.
  await page.locator('.viewer-controls button[title^="Half playback resolution"]').first().click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(300);

  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: SAMPLE_INTERVAL_US });

  await page.locator(PLAY).first().click().catch(() => undefined);
  const started = await page.locator(PAUSE).first().waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
  if (!started) throw new Error("transport did not start — nothing to profile");

  // Warm up BEFORE recording: the first second is decoder spin-up and first-frame texture allocation,
  // which is real but is not what a viewer experiences during sustained playback.
  await page.waitForTimeout(1_500);
  await cdp.send("Profiler.start");
  await page.waitForTimeout(SECONDS * 1_000);
  const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };

  const stats = await page.evaluate(() => (globalThis as Record<string, any>).__rfFrameStats ?? null);
  await page.locator(PAUSE).first().click({ timeout: 3_000 }).catch(() => undefined);

  console.log(`\nbase: ${process.env.PROBE_BASE ?? "http://localhost:5173"}`);
  if (stats) {
    console.log(
      `HUD at stop: fps ${Number(stats.fps).toFixed(1)} · mediaFps ${Number(stats.mediaFps).toFixed(1)} · ` +
        `frame ${Number(stats.avgFrameMs).toFixed(1)}ms · draw ${Number(stats.avgDrawMs).toFixed(2)}ms · ` +
        `dropped ${(Number(stats.droppedRatio) * 100).toFixed(0)}% · scale ${stats.renderScale}`
    );
  }
  report(profile, `CPU profile · ${SECONDS}s of playback`);

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
