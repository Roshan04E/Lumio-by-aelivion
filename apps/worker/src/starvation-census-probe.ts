/**
 * ADR-020 slice A — the starvation census, observed rather than asserted.
 *
 * ## Why this run exists
 *
 * Slice A shipped four unconditional readings (`starvedSources`, `starvedLongestMs`,
 * `admissionRecoveries`, `admissionPermanentDenials`) and passed its decoder soak with `capMisses 0`.
 * That soak proved slice A BREAKS NOTHING. It did not test slice A: with nothing denied, the registry
 * was empty for the whole run and the recovery pass never rendered a verdict.
 *
 * Shipping a health reading that has never been seen non-zero is DEBT-012 — a metric backed by a
 * signal nobody has watched fire. Every other reading in this programme has been held to the standard
 * that a counter must be observed MOVING before it is trusted; these do not get an exemption for being
 * new. This fixture denies on purpose, so the counters have something to say.
 *
 * ## Why the run is long
 *
 * Two constants gate the branches, and a short run silently skips both:
 *
 *   - `ADMISSION_RECOVERY_IDLE_MS` (10s) rate-limits the pass. A 12s probe may catch ONE sweep.
 *   - `PERMANENT_DENIAL_AFTER_MS` (30s) gates §6.11's terminal. Nothing under 30s can ever reach it.
 *
 * So the observation window is sized from the product's own constants rather than a round number, and
 * the terminal is the point of the run: it is the half of §6.11 that shipped code could not reach at
 * all before slice A.
 *
 * ## The vacuity guard, stated before the numbers
 *
 * `starvedSources 0` has two incompatible meanings — nothing is starved, or nothing was ever denied so
 * the registry was never populated. They are the same reading. This probe therefore treats
 * `capMisses == 0` as **VOID, not PASS**: an arrangement that never exceeded the budget cannot say
 * anything about what happens when it does.
 *
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker starvation:census
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ADMISSION_RECOVERY_IDLE_MS, PERMANENT_DENIAL_AFTER_MS } from "@orreris/shared";
import {
  addAssetSourceMediaIn,
  addMediaInBoundTo,
  defaultClipPath,
  importAssets,
  reachEditor,
} from "./browser/editor-session.js";

const SOURCES = Math.max(2, Number(process.env.PROBE_SOURCES ?? 6));
/**
 * Long enough to clear the terminal with margin for the sweep cadence: a waiter denied just after a
 * sweep is only examined at the NEXT one, so the worst case is the terminal plus a full sweep interval.
 */
const SECONDS = Number(process.env.PROBE_SECONDS ?? Math.ceil((PERMANENT_DENIAL_AFTER_MS + 2 * ADMISSION_RECOVERY_IDLE_MS) / 1000) + 5);
const SAMPLE_MS = 500;
/** Proxy builds are not instant; the routing flip trails project load by roughly ten seconds per source. */
const WC_ENGAGE_TIMEOUT_MS = Number(process.env.PROBE_WC_TIMEOUT_MS ?? 120_000);
/** The decoder budget this fixture is built to exceed. */
const NOMINAL_CAP = 4;

interface Census {
  tMs: number;
  capMisses: number;
  starvedSources: number;
  starvedLongestMs: number;
  admissionRecoveries: number;
  admissionPermanentDenials: number;
  admissionRecoverySweeps: number;
  admissionRecoveryWaits: number;
  admissionRecoveryTicks: number;
  admissionRecoveryEmptyTicks: number;
  admissionReacquireAttempts: number;
  admissionReacquireGrants: number;
  tickInterval: { count: number; meanMs: number; minMs: number; maxMs: number };
  rejectShortfall: { count: number; meanMs: number; minMs: number; maxMs: number };
  active: number;
  activeSoftware: number;
}

/**
 * Wait, WHILE PAUSED, until at least `want` sources have left the `<video>` element path.
 *
 * Three things make this probe-local rather than a call to `awaitWebCodecsEngaged`:
 *
 *  1. **Count, not existence.** The shared helper is `.some(mode !== "element")`, so ONE engaged source
 *     out of six reports "engaged". This fixture's whole premise is that MORE sources than slots ask at
 *     once; one engaged source cannot exceed a 4-slot budget, so the shared predicate would wave through
 *     an arrangement that is guaranteed to read `capMisses 0`. (This is the strengthening booked as
 *     harness slice C. Doing it here does not do it globally — the shared helper is unchanged.)
 *
 *  2. **Paused.** Source-proxy builds SUSPEND during playback, so a probe that presses play on arrival
 *     freezes the routing exactly as it found it and then measures a subsystem that never started.
 *
 *  3. **It returns the routing.** A void run has to be attributable, and "which modes did the page
 *     actually report" is the difference between "WebCodecs never started" and "it started and the
 *     budget still was not exceeded" — two failures with completely different responses.
 */
async function awaitWcFraction(
  page: Page,
  want: number,
  timeoutMs: number
): Promise<{ engaged: number; modes: Record<string, string> }> {
  const started = Date.now();
  let modes: Record<string, string> = {};
  while (Date.now() - started < timeoutMs) {
    modes = await page.evaluate(
      () => (globalThis as unknown as { __rfWcMode?: Record<string, string> }).__rfWcMode ?? {}
    );
    const engaged = Object.values(modes).filter((m) => m !== "element").length;
    if (engaged >= want) return { engaged, modes };
    await page.waitForTimeout(1_000);
  }
  return { engaged: Object.values(modes).filter((m) => m !== "element").length, modes };
}

async function readCensus(page: Page, tMs: number): Promise<Census | null> {
  const raw = await page.evaluate(() => {
    const p = (globalThis as Record<string, any>).__rfWcPool;
    if (!p) return null;
    return {
      capMisses: Number(p.capMisses ?? 0),
      starvedSources: Number(p.starvedSources ?? -1),
      starvedLongestMs: Number(p.starvedLongestMs ?? -1),
      admissionRecoveries: Number(p.admissionRecoveries ?? -1),
      admissionPermanentDenials: Number(p.admissionPermanentDenials ?? -1),
      admissionRecoverySweeps: Number(p.admissionRecoverySweeps ?? -1),
      admissionRecoveryWaits: Number(p.admissionRecoveryWaits ?? -1),
      admissionRecoveryTicks: Number(p.admissionRecoveryTicks ?? -1),
      admissionRecoveryEmptyTicks: Number(p.admissionRecoveryEmptyTicks ?? -1),
      admissionReacquireAttempts: Number(p.admissionReacquireAttempts ?? -1),
      admissionReacquireGrants: Number(p.admissionReacquireGrants ?? -1),
      tickInterval: p.recoveryTickIntervalMs ?? { count: 0, meanMs: 0, minMs: 0, maxMs: 0 },
      rejectShortfall: p.recoveryRejectShortfallMs ?? { count: 0, meanMs: 0, minMs: 0, maxMs: 0 },
      active: Number(p.active ?? 0),
      activeSoftware: Number(p.activeSoftware ?? 0),
    };
  });
  return raw ? { tMs, ...raw } : null;
}

function seedClips(count: number): string[] {
  const first = defaultClipPath(SECONDS + 10);
  const dir = path.dirname(first);
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  const picked = [first, ...files.filter((f) => f !== first)].slice(0, count);
  if (picked.length < count) throw new Error(`need ${count} distinct clips, found ${picked.length} in ${dir}`);
  return picked;
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) {
    console.log(
      "[census] ⚠ PIXEL_BROWSER_CHANNEL is unset — this measures SwiftShader at ~8fps, where the\n" +
        "        contention this fixture depends on does not reproduce. Re-run with =chrome."
    );
  }
  let browser: Browser | null = null;
  let context: BrowserContext;
  if (process.env.PROBE_PROFILE) {
    context = await chromium.launchPersistentContext(process.env.PROBE_PROFILE, {
      ...(channel ? { channel } : {}),
      viewport: { width: 1600, height: 900 },
    });
  } else {
    browser = await chromium.launch(channel ? { channel } : {});
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  }
  const page = context.pages()[0] ?? (await context.newPage());

  const clips = seedClips(SOURCES);
  const projectUrl = await reachEditor(page, { clipPath: clips[0]!, flags: "wcDecode=1" });
  console.log(`project: ${projectUrl}`);
  console.log(`target:  ${SOURCES} distinct sources against a ${NOMINAL_CAP}-slot budget`);
  console.log(
    `window:  ${SECONDS}s  (terminal ${PERMANENT_DENIAL_AFTER_MS / 1000}s + 2 × sweep ${ADMISSION_RECOVERY_IDLE_MS / 1000}s + margin)`
  );

  const tiles = await importAssets(page, clips.slice(1));
  console.log(`  · asset bin: ${tiles} tile(s) after import`);
  const first = await addAssetSourceMediaIn(page);
  let bound = first.ok ? 1 : 0;
  console.log(`  · MediaIn 1: ${first.ok ? "bound" : `FAILED at gate \`${first.gate}\``}`);
  for (let i = 1; i < SOURCES; i += 1) {
    const result = await addMediaInBoundTo(page, i);
    if (result.ok) bound += 1;
    console.log(`  · MediaIn ${i + 1}: ${result.ok ? "bound" : `FAILED at gate \`${result.gate}\``}`);
  }
  console.log(`sources bound: ${bound}/${SOURCES}`);

  // Engagement is awaited HERE — after every source is bound, and before play. Awaiting it earlier (as
  // the first version of this probe did) asks the question when only the host clip exists, and the
  // answer is about a one-source comp that cannot exceed anything.
  // ── WHY THIS WAITS FOR THE CAP, NOT FOR MOST SOURCES.
  //
  // The first version of this probe required ≥5 of 6 sources off the element path before playing, and
  // declared VOID otherwise. That precondition is CIRCULAR, and it voided a run that had in fact
  // produced the denial it was looking for (capMisses 4, two sources starved).
  //
  // The reason is DEBT-013 itself: a source denied a decoder slot FALLS BACK to the `<video>` element.
  // So "still on element" is the signature of the defect under test, and demanding that most sources
  // have left it is demanding that starvation not occur. On a fixture built to starve, the guard can
  // never pass — it would reject exactly the runs worth reading.
  //
  // The honest precondition is that the DECODER SUBSYSTEM RAN, which is proven by the budget filling:
  // once `NOMINAL_CAP` sources are off-element, every further source is competing for a full pool and
  // any denial is a real one. Whether the losers escape is the RESULT, not the entry condition.
  const wantEngaged = Math.min(bound, NOMINAL_CAP);
  console.log(`  · waiting (paused) for the ${wantEngaged}-slot budget to fill…`);
  const routing = await awaitWcFraction(page, wantEngaged, WC_ENGAGE_TIMEOUT_MS);
  console.log(`  · routing: ${routing.engaged}/${Object.keys(routing.modes).length} off-element  ${JSON.stringify(routing.modes)}`);

  const play = page.locator('button[title*="Play"], button[aria-label*="Play"]').first();
  await play.click({ timeout: 10_000 }).catch(() => undefined);

  // ── TRANSPORT (slice D's trigger, and precondition P-c) ───────────────────
  // Slice D re-asks at a seek, a scrub, or a pause. If no boundary occurs, `admissionReacquireAttempts`
  // reads 0 for a reason that has nothing to do with the mechanism, so the run has to DRIVE transport
  // and count what it drove — otherwise "the layer never re-asked" and "the trigger never fired" are
  // the same zero.
  // `addMediaInBoundTo` ends on the FLAREX tab, where the timeline ruler is not mounted. Without this
  // the boundary driver silently finds no ruler and P-c fails for a harness reason that looks exactly
  // like a product one.
  await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const ruler = await page.evaluate(() => {
    const el = document.querySelector(".timeline-ruler");
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return r.width > 20 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  });
  if (!ruler) console.log("  · ⚠ no timeline ruler — transport cannot be driven; P-c will fail.");

  const samples: Census[] = [];
  const started = Date.now();
  let boundaries = 0;
  let step = 0;
  while (Date.now() - started < SECONDS * 1_000) {
    const sample = await readCensus(page, Date.now() - started);
    if (sample) samples.push(sample);
    if (ruler) {
      // Long jumps and short scrubs alternate — they abandon in-flight work and stay in the same GOP
      // neighbourhood respectively, and both are boundaries. Every fourth step is a pause/play cycle,
      // which is the OTHER permitted moment and the one that exercises the paused branch.
      if (step % 4 === 3) {
        await play.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        await play.click({ timeout: 5_000 }).catch(() => undefined);
        boundaries += 1;
      } else {
        const frac = step % 2 === 0 ? 0.1 + (0.8 * ((step / 2) % 5)) / 5 : 0.5 + 0.05 * ((step % 6) - 3);
        const x = ruler.x + ruler.width * Math.min(0.95, Math.max(0.05, frac));
        await page.mouse.click(x, ruler.y + ruler.height / 2).catch(() => undefined);
        boundaries += 1;
      }
      step += 1;
    }
    await page.waitForTimeout(SAMPLE_MS);
  }
  console.log(`  · transport boundaries driven: ${boundaries}`);

  console.log("\n════ starvation census ════");
  if (samples.length === 0) {
    console.log("[census] ⚠ VOID — __rfWcPool never became readable; nothing can be concluded.");
    process.exitCode = 1;
    await (browser ? browser.close() : context.close());
    return;
  }

  const last = samples[samples.length - 1]!;
  const peakStarved = Math.max(...samples.map((s) => s.starvedSources));
  const peakLongest = Math.max(...samples.map((s) => s.starvedLongestMs));
  const fieldsPresent = last.starvedSources >= 0 && last.admissionRecoverySweeps >= 0;

  console.log(`  samples          ${samples.length} over ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  capMisses        ${last.capMisses}`);
  console.log(`  starvedSources   peak ${peakStarved} · final ${last.starvedSources}`);
  console.log(`  starvedLongestMs peak ${peakLongest} · final ${last.starvedLongestMs}`);
  console.log(
    `  recovery         ticks ${last.admissionRecoveryTicks} · sweeps ${last.admissionRecoverySweeps}` +
      ` · empty ${last.admissionRecoveryEmptyTicks} · waits ${last.admissionRecoveryWaits}`
  );
  console.log(`  outcomes         retries ${last.admissionRecoveries} · permanentDenials ${last.admissionPermanentDenials}`);
  console.log(
    `  slice D          boundaries ${boundaries} · reacquire attempts ${last.admissionReacquireAttempts}` +
      ` · grants ${last.admissionReacquireGrants}`
  );
  const ti = last.tickInterval;
  const rs = last.rejectShortfall;
  console.log(
    `  OQ10 tick period n=${ti.count} · mean ${ti.meanMs}ms · min ${ti.minMs}ms · max ${ti.maxMs}ms` +
      `   (limit ${ADMISSION_RECOVERY_IDLE_MS}ms)`
  );
  console.log(
    `  OQ10 rejects     n=${rs.count} · shortfall mean ${rs.meanMs}ms · min ${rs.minMs}ms · max ${rs.maxMs}ms`
  );
  if (rs.count > 0) {
    // The whole point of the shortfall reading: a few ms means the limit is beating against the cadence
    // it rides; seconds means a genuinely different clock, and loosening the limit would be the wrong fix.
    console.log(
      rs.maxMs <= 250
        ? "                   → BEAT: every rejection missed by a hair. The tick is the clock; a second\n" +
            "                     wall-clock limit of the same period is the interference."
        : `                   → NOT a beat: rejections miss by up to ${Math.round(rs.maxMs)}ms. Something is\n` +
            "                     ticking on a different cadence; find it before touching the constant."
    );
  }
  console.log(`  sessions         active ${last.active} · software ${last.activeSoftware}`);

  // Trajectory, so a constant is not mistaken for a clock.
  const trace = samples
    .filter((_, i) => i % Math.max(1, Math.floor(samples.length / 8)) === 0)
    .map((s) => `${Math.round(s.tMs / 1000)}s:${s.starvedSources}/${Math.round(s.starvedLongestMs / 1000)}s`)
    .join("  ");
  console.log(`  trajectory       ${trace}   (starved/longest)`);

  // ── PRE-REGISTERED VERDICT ────────────────────────────────────────────────
  if (!fieldsPresent) {
    console.log(
      "\n[census] ⚠ VOID — the slice A readings are absent from __rfWcPool. The page is running a build\n" +
        "         without them; every zero below would be an artefact of the build, not of the runtime."
    );
    process.exitCode = 1;
  } else if (routing.engaged === 0) {
    console.log(
      `\n[census] ⚠ VOID — no source ever left the element path, which has NO decoder budget. Nothing\n` +
        "         could be denied because nothing was ever asked of the pool. Every zero above describes\n" +
        "         a subsystem that never ran — a precondition failure, not a result about the census."
    );
    process.exitCode = 1;
  } else if (last.capMisses === 0) {
    console.log(
      `\n[census] ⚠ VOID — ${bound} sources were bound and ${routing.engaged} reached the decoder, but the\n` +
        "         budget was never exceeded (capMisses 0). 'starvedSources 0' here means the registry was\n" +
        "         never populated, NOT that nothing starved. Raise PROBE_SOURCES."
    );
    process.exitCode = 1;
  } else {
    const checks: [string, boolean, string][] = [
      ["starvation is visible as a state", peakStarved > 0, `peak starvedSources ${peakStarved}`],
      ["the duration reading tracks real time", peakLongest > ADMISSION_RECOVERY_IDLE_MS, `peak ${peakLongest}ms`],
      ["the host tick reaches recovery at all", last.admissionRecoveryTicks > 0, `ticks ${last.admissionRecoveryTicks}`],
      ["the recovery pass ran against a non-empty registry", last.admissionRecoverySweeps > 0, `sweeps ${last.admissionRecoverySweeps}`],
      [
        // OQ10 replaced the old form of this check. It used to compare sweeps against a NOMINAL rate
        // derived from the constant, which is what led to reading `ticks > sweeps` as "the rate limit
        // rejects most ticks" — a branch nobody had counted. The honest check is that the accounting
        // closes: every tick is a sweep, a rejection, or an empty registry, and nothing is unexplained.
        "every recovery tick is accounted for (ticks = sweeps + rejects + empty)",
        last.admissionRecoveryTicks ===
          last.admissionRecoverySweeps + last.rejectShortfall.count + last.admissionRecoveryEmptyTicks,
        `${last.admissionRecoveryTicks} = ${last.admissionRecoverySweeps} + ${last.rejectShortfall.count} + ${last.admissionRecoveryEmptyTicks}`,
      ],
      ["it rendered a per-waiter verdict", last.admissionRecoveryWaits > 0, `waits ${last.admissionRecoveryWaits}`],
      [
        // Unconditional, because this fixture starves for minutes: any waiter past the terminal that is
        // still undeclared is §6.11's forbidden third outcome, which is the whole reason slice A exists.
        "§6.11's terminal is reachable in the live runtime",
        peakLongest < PERMANENT_DENIAL_AFTER_MS || last.admissionPermanentDenials > 0,
        `starved ${Math.round(peakLongest / 1000)}s vs ${PERMANENT_DENIAL_AFTER_MS / 1000}s terminal · declared ${last.admissionPermanentDenials}`,
      ],
    ];
    console.log("");
    for (const [name, ok, detail] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}  (${detail})`);
    const failed = checks.filter(([, ok]) => !ok);
    if (failed.length === 0) {
      console.log("\n[census] ✓ PASS — every slice A reading was observed moving under real denial.");
    } else {
      console.log(
        `\n[census] ✗ FAIL — ${failed.length}/${checks.length} readings never moved under real denial.\n` +
          "         With capMisses > 0 these are NOT vacuous zeros: something was denied and the census\n" +
          "         did not report it. The most likely cause is that recovery's host tick does not run\n" +
          "         on this path — a mechanism wired to a cadence that never fires."
      );
      process.exitCode = 1;
    }

    // ── SLICE D, reported SEPARATELY from slice A ─────────────────────────────
    // Kept apart on purpose. Slice A's readings can pass while D is untested, and folding them into one
    // verdict would let A's green flatter D — which is the exact mistake that let slice A ship on a
    // `capMisses 0` soak in the first place.
    console.log("\n──── slice D — the transport re-acquire ────");
    if (boundaries === 0) {
      console.log(
        "  ⚠ P-c FAILED — no transport boundary was driven, so slice D's trigger never fired.\n" +
          "    `reacquire attempts 0` says nothing about the mechanism here."
      );
      process.exitCode = 1;
    } else if (last.admissionRecoveries === 0) {
      // The measured case, and NOT a defect in D. Recovery only grants a permission when capacity has
      // freed; on a pool that stays full for the whole session it grants none, so there is nothing for
      // the layer to act on. D is untested rather than failing, and saying "PASS" here would be the
      // vacuity this probe exists to prevent.
      console.log(
        `  ⚠ UNEXERCISED — recovery granted no eligibility all run (retries 0), because free capacity\n` +
          `    never appeared: the pool stayed full for the whole session. ${boundaries} boundaries were\n` +
          "    driven and correctly produced 0 re-asks, since no source was ever permitted to re-ask.\n" +
          "    THIS RUN SHOWS SLICE D BREAKS NOTHING; IT DOES NOT SHOW IT WORKS.\n" +
          "    Exercising D1/D2 needs a fixture where capacity frees ASYMMETRICALLY — one source leaving\n" +
          "    while another stays starved. Six simultaneous MediaIns cannot produce that: they all live\n" +
          "    and die together, so every release is a full teardown followed by a fresh lottery."
      );
    } else {
      const dChecks: [string, boolean, string][] = [
        ["a permitted source actually re-asked", last.admissionReacquireAttempts > 0, `attempts ${last.admissionReacquireAttempts}`],
        ["a re-ask was served (D1/D2)", last.admissionReacquireGrants > 0, `grants ${last.admissionReacquireGrants}`],
        [
          // C-D4. The clock must survive a refused re-ask, or the terminal becomes unreachable for the
          // sources that try hardest — retry hygiene that quietly defeats slice A.
          "a refused re-ask did not reset the starvation clock (C-D4)",
          last.admissionReacquireAttempts === last.admissionReacquireGrants || peakLongest >= ADMISSION_RECOVERY_IDLE_MS,
          `peak starved ${Math.round(peakLongest / 1000)}s across ${last.admissionReacquireAttempts - last.admissionReacquireGrants} refusal(s)`,
        ],
      ];
      for (const [name, ok, detail] of dChecks) console.log(`  ${ok ? "✓" : "✗"} ${name}  (${detail})`);
      if (dChecks.some(([, ok]) => !ok)) process.exitCode = 1;
    }
  }

  await (browser ? browser.close() : context.close());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
