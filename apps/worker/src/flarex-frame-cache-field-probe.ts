/**
 * ADR-021 3b — FIELD probe. Does the frame cache do anything in the real editor, and is the picture
 * still right when it does?
 *
 * `flarex:frame-cache-gate` proves the MECHANISM: it drives `SceneCompositor` directly with keys it
 * declares itself, so it can prove correctness and falsifiability but says nothing about whether the
 * product's own host ever declares a key, or whether the key it declares is the right one. Those are
 * exactly the two things that decide whether this ships a win or a stale picture, and neither is
 * visible from a harness that plays host to itself.
 *
 * WHY EVERY SWEEP HAPPENS IN ONE PAGE LOAD, and this is the whole design.
 *
 * The first version compared a cache-on LOAD against a cache-off LOAD. That is structurally unsound:
 * a Flarex comp on live footage does not render byte-identically from one load to the next, and the
 * measured noise floor between two cache-off LOADS ranged from **0 to 6 of 6 positions** across runs.
 * An instrument whose noise can swallow its entire signal cannot answer the question it exists for —
 * and it duly produced one green run and three reds with no way to tell which was the truth. Adding a
 * control arm and then a warm-up arm each reduced the redness without reaching green, which is the
 * signature of peeling confounds rather than finding a defect.
 *
 * So the cache is toggled AT RUNTIME (`__rfFrameCacheBypass`, read per frame by ScenePreviewCanvas)
 * and every sweep runs seconds apart inside the same load, over the same warmed decoders:
 *
 *   WARM-UP  (bypassed, discarded) — so no sweep that counts is the coldest one.
 *   A-FILL   (cache on)   — first pass over the ground: all misses, fills the cache.
 *   A-SERVE  (cache on)   — the same ground again. This is the sweep that must be SERVED.
 *   B        (bypassed)   — the same ground rendered from scratch. The oracle.
 *   C        (bypassed)   — again. B-vs-C is the noise floor, now within one load.
 *
 * A-SERVE must equal B, and must register real hits. B-vs-C is a PRECONDITION rather than something
 * to subtract: if two bypassed sweeps in one load disagree at more than one position, the oracle is
 * not reproducible and the run VOIDs instead of passing vacuously.
 *
 * A screenshot, not a canvas readback: the preview is a WebGL canvas without `preserveDrawingBuffer`,
 * so a `drawImage` readback after the present is not reliably the presented picture, and an
 * instrument that is sometimes blank cannot tell a stale serve from its own flakiness.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker flarex:frame-cache-field
 */
import crypto from "node:crypto";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { addAssetSourceMediaIn, awaitWebCodecsEngaged, defaultClipPath, reachEditor } from "./browser/editor-session.js";

/**
 * Ruler positions, as fractions of its width — CALIBRATED at runtime, never hardcoded.
 *
 * WHY, measured 2026-08-16. Fixed fractions [0.12 … 0.42] assumed the ruler's span matched the
 * composition's. It does not: the ruler ran ~70s wide over a ~16.8s comp, so every stop from 0.24 up
 * CLAMPED to t=16.800 — the last frame. Scrubbing repeatedly past the end is not a measurement of the
 * cache; it samples whatever the decoder happened to leave on screen, and the results said exactly
 * that. One run reported a 4-position STALE SERVE and the next a 3-position unstable ORACLE, both
 * confined entirely to the clamped stops, while the two in-range stops (t=8.4, 12.6) were identical
 * across every sweep of both runs.
 *
 * That is the instrument failing the rule it exists to enforce: it must be able to tell the answers
 * apart. Sampling one frame six times cannot distinguish a stale serve from a correct one.
 */
let STOPS: number[] = [];
/** Settle after each scrub. A Flarex comp on live footage needs a decode to land before the picture
 *  is the picture; screenshotting early would compare two half-drawn frames and blame the cache.
 *  `FIELD_SETTLE_MS` raises it — the instrument for telling "the picture at this t is still
 *  CONVERGING" (a longer wait stabilises it) apart from "the picture at this t is NONDETERMINISTIC"
 *  (no wait stabilises it). Those have opposite meanings for whether a frame cache is sound here. */
const SETTLE_MS = Number(process.env.FIELD_SETTLE_MS ?? 900);

interface Sample {
  stop: number;
  hash: string;
  time: number | null;
}

async function rulerGeometry(page: Page): Promise<{ y: number; left: number; width: number } | null> {
  return page.evaluate(() => {
    const ruler = document.querySelector(".timeline-ruler");
    if (!(ruler instanceof HTMLElement)) return null;
    const r = ruler.getBoundingClientRect();
    if (r.width < 50) return null;
    return { y: r.top + r.height / 2, left: r.left, width: r.width };
  });
}

async function shotHash(page: Page): Promise<string> {
  const canvas = page.locator("canvas").first();
  const buffer = await canvas.screenshot({ timeout: 15_000 });
  return crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 16);
}

async function readFrameCache(page: Page): Promise<Record<string, number | boolean>> {
  return page.evaluate(() => ({
    ...((window as unknown as { __rfFrameCache?: Record<string, number | boolean> }).__rfFrameCache ?? {}),
  }));
}

async function setBypass(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v: boolean) => {
    (window as unknown as { __rfFrameCacheBypass?: boolean }).__rfFrameCacheBypass = v;
  }, on);
}

async function scrubTo(page: Page, geometry: { y: number; left: number; width: number }, fraction: number): Promise<number | null> {
  await page.mouse.click(geometry.left + geometry.width * fraction, geometry.y);
  await page.waitForTimeout(400);
  return page.evaluate(() => (window as unknown as { __rfClock?: { committed: number } }).__rfClock?.committed ?? null);
}

/**
 * Find the fractions that actually land INSIDE the composition, and spread the stops across them.
 *
 * The ruler is linear in t, so one in-range reading gives seconds-per-fraction, and a deliberately
 * over-far scrub gives the composition duration (it clamps to the end). Everything past that fraction
 * is the same frame, which is the trap this replaces.
 */
async function calibrateStops(page: Page, geometry: { y: number; left: number; width: number }, count: number): Promise<number[] | null> {
  const near = await scrubTo(page, geometry, 0.1);
  if (near == null || near <= 0) {
    console.log(`  calibration           : t(0.10)=${near ?? "null"} — no usable reference scrub`);
    return null;
  }
  const secondsPerFraction = near / 0.1;

  // A click PAST the composition is IGNORED, not clamped -- the playhead simply stays where it was
  // (measured: t(0.92) read back 0, the initial value, rather than the comp duration). So the end
  // cannot be found by scrubbing far and reading the clamp; it has to be searched for. A stop is
  // "in range" when the playhead actually arrives near where the ruler's linear mapping says it should.
  let lo = 0.1;
  let hi = 0.92;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const t = await scrubTo(page, geometry, mid);
    const expected = mid * secondsPerFraction;
    if (t != null && Math.abs(t - expected) < Math.max(0.5, expected * 0.05)) lo = mid;
    else hi = mid;
  }
  const endFraction = lo;
  console.log(
    `  calibration           : ${secondsPerFraction.toFixed(1)}s per ruler-fraction, comp ends at ~${endFraction.toFixed(3)} ` +
      `(~${(endFraction * secondsPerFraction).toFixed(1)}s)`,
  );
  if (!Number.isFinite(endFraction) || endFraction <= 0.05) return null;
  // Stay clear of both ends: t=0 is often a different code path, and the last frame is where a scrub
  // past the end leaves the playhead.
  const first = endFraction * 0.12;
  const last = Math.min(endFraction * 0.88, 0.98);
  if (last <= first) return null;
  return Array.from({ length: count }, (_, i) => first + ((last - first) * i) / (count - 1));
}

async function sweep(page: Page, geometry: { y: number; left: number; width: number }): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const stop of STOPS) {
    await page.mouse.click(geometry.left + geometry.width * stop, geometry.y);
    await page.waitForTimeout(SETTLE_MS);
    const time = await page.evaluate(() => (window as unknown as { __rfClock?: { committed: number } }).__rfClock?.committed ?? null);
    out.push({ stop, hash: await shotHash(page), time });
  }
  return out;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex:frame-cache-field" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk (see measurement-preconditions).");

  const browser = await chromium.launch(channel ? { channel } : {});
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());

  // `frameCache=1` explicitly: the shipped default is off until this probe is green, so an arm that
  // relied on the default would measure a switched-off cache and report a flawless pass.
  const projectUrl = await reachEditor(page, { clipPath: defaultClipPath(20), flags: "wcDecode=1&frameCache=1" });
  console.log(`  project               : ${projectUrl}`);
  if (!(await awaitWebCodecsEngaged(page))) console.log("  subsystem liveness    : ⚠ WebCodecs never engaged");
  else console.log("  subsystem liveness    : WebCodecs engaged");

  // A Flarex comp on the clip is what makes the frame ELIGIBLE at all — a plain clip carries no
  // content token and is deliberately not cacheable until step 4 puts the timeline on the seam.
  const seeded = await addAssetSourceMediaIn(page);
  console.log(`  flarex comp           : ${seeded.ok ? "created" : `FAILED at gate \`${seeded.gate}\` ${seeded.detail ?? ""}`}`);
  if (!seeded.ok) {
    console.log("\n⚠ VOID — no Flarex comp, so no frame this probe measures could ever be eligible.");
    await browser.close();
    process.exit(2);
  }

  await page.goto(`${projectUrl}&frameCache=1`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(10_000);

  const geometry = await rulerGeometry(page);
  if (!geometry) {
    console.error("\n⚠ VOID — the timeline ruler was not on screen, so no scrub happened.");
    await browser.close();
    process.exit(2);
  }

  const calibrated = await calibrateStops(page, geometry, 6);
  if (!calibrated) {
    console.error("\n⚠ VOID — could not calibrate ruler stops against the composition duration.");
    await browser.close();
    process.exit(2);
  }
  STOPS = calibrated;
  console.log(`  ruler stops           : ${STOPS.map((s) => s.toFixed(3)).join(", ")} (calibrated to the comp duration)`);

  await setBypass(page, true);
  await sweep(page, geometry); // WARM-UP, discarded.

  await setBypass(page, false);
  const before = await readFrameCache(page);
  await sweep(page, geometry); // A-FILL
  const afterFill = await readFrameCache(page);
  const aServe = await sweep(page, geometry); // A-SERVE
  const afterServe = await readFrameCache(page);

  await setBypass(page, true);
  const b = await sweep(page, geometry);
  const c = await sweep(page, geometry);

  await browser.close();

  let failures = 0;
  const fail = (msg: string) => {
    failures += 1;
    console.error(`FAIL  ${msg}`);
  };
  const ok = (msg: string) => console.log(`  ok  ${msg}`);

  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const fillHits = n(afterFill.hits) - n(before.hits);
  const serveHits = n(afterServe.hits) - n(afterFill.hits);
  const serveMisses = n(afterServe.misses) - n(afterFill.misses);
  console.log(
    `\n  eligible=${String(afterServe.eligible ?? false)} · A-FILL hits=${fillHits} · A-SERVE hits=${serveHits} misses=${serveMisses}` +
      ` · stores=${n(afterServe.stores)} declined=${n(afterServe.declined)} entries=${n(afterServe.entries)} bytes=${(n(afterServe.bytes) / 1048576).toFixed(1)}MB`,
  );

  console.log("\n  position |  t       | A-SERVE          | B (fresh)        | C (fresh)");
  for (let i = 0; i < aServe.length; i++) {
    const a = aServe[i]!;
    const flag = a.hash !== b[i]!.hash ? (b[i]!.hash === c[i]!.hash ? "  <== A differs, B==C" : "  (B!=C: noise)") : "";
    console.log(`    ${a.stop.toFixed(2)}   | ${(a.time ?? -1).toFixed(3).padStart(8)} | ${a.hash} | ${b[i]!.hash} | ${c[i]!.hash}${flag}`);
  }

  if (afterServe.eligible !== true) fail("the host never declared a frame key on a Flarex comp — the 3b wiring is inert in the product");
  else ok("the shipped host declares a frame key for a Flarex comp frame");

  // THE STOPS MUST LAND ON DISTINCT TIMES, or this probe is comparing one frame against itself.
  // Not a soft warning: with fixed fractions the ruler ran past the end of the comp and FOUR of six
  // stops clamped to the same t, which produced a 4-position "STALE SERVE" in one run and a
  // 3-position unstable "ORACLE" in the next -- both entirely inside the clamped region, while the
  // in-range stops agreed perfectly. An instrument that cannot tell the answers apart must VOID.
  const times = aServe.map((s) => (s.time == null ? null : Math.round(s.time * 1000)));
  const distinctTimes = new Set(times.filter((t) => t != null)).size;
  if (distinctTimes < STOPS.length) {
    console.error(
      `\n⚠ VOID — the ${STOPS.length} stops produced only ${distinctTimes} distinct playhead time(s) ` +
        `[${times.map((t) => (t == null ? "?" : (t / 1000).toFixed(3))).join(", ")}]. The scrub is clamping at the ` +
        `end of the composition, so the repeated stops sample one frame and prove nothing about the cache.`,
    );
    process.exit(2);
  }
  ok(`the ${STOPS.length} stops land on ${distinctTimes} distinct playhead times`);

  const signal: number[] = [];
  const noise: number[] = [];
  for (let i = 0; i < aServe.length; i++) {
    if (b[i]!.hash !== c[i]!.hash) noise.push(aServe[i]!.stop);
    else if (aServe[i]!.hash !== b[i]!.hash) signal.push(aServe[i]!.stop);
  }
  console.log(`      attributable ${signal.length} [${signal.join(", ")}] · noise floor ${noise.length} [${noise.join(", ")}]`);

  // The noise floor is a PRECONDITION, not a subtraction. Cross-load noise once reached 6 of 6, at
  // which point "no divergence above the floor" is a vacuous pass dressed as a result. Same-load
  // sweeps should be near-deterministic; when they are not, this run cannot answer and says so.
  if (noise.length > 1) {
    console.error(
      `\n⚠ VOID — ${noise.length} of ${STOPS.length} positions differ between two BYPASSED sweeps in the same load. The oracle is not reproducible, so nothing here can be attributed to the cache.`,
    );
    process.exit(2);
  }
  ok(`the uncached oracle is reproducible within a load (${noise.length} unstable position(s))`);

  if (signal.length > 0) fail(`cache-served frames differ from a fresh render at ${signal.length} position(s) [${signal.join(", ")}] — a STALE SERVE in the shipped host`);
  else ok("every cache-served frame is pixel-identical to a fresh render of the same frame");

  if (serveHits <= 0) fail(`the A-SERVE sweep registered ${serveHits} hits — the cache is wired but never serves, so it costs memory and returns nothing`);
  else ok(`the second pass over the same ground served ${serveHits} of ${serveHits + serveMisses} frames from cache`);

  const distinct = new Set(b.map((s) => s.hash)).size;
  if (distinct <= 1) fail(`the uncached sweep produced ONE distinct picture across ${STOPS.length} positions — the scrub did not move, so the comparison proves nothing`);
  else ok(`the scrub genuinely moves the picture (${distinct} distinct frames across ${STOPS.length} positions)`);

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nflarex frame-cache field probe: the shipped wiring serves cached frames and the picture is unchanged");
}

void main();
