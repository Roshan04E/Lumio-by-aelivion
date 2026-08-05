/**
 * ADR-013 Phase 0 — the playback-contention fixture. ONE fixture, TWO readings, recorded separately.
 *
 * ## Why this fixture exists, and why it is not only M4's instrument
 *
 * Stage 1 found that all contention on the existing fixture is a **mount-storm transient**: `capMisses`
 * does not move once during 20s of steady-state playback. That voids M4's hysteresis bound — you cannot
 * size a damping constant against excursions that never occur — but the consequence is larger than one
 * magnitude:
 *
 * > Checkpoint 1 established that the Acquisition Scheduler's acceptance criterion is **routing
 * > determinism under contention** (DEBT-011). If contention only exists as a mount transient, there is
 * > no way to test the scheduler doing its job *during playback* — which is the whole point of it.
 *
 * So this is **acceptance infrastructure**, not merely a probe. Seeks and transport jumps are what
 * force re-acquisition against a full pool while the picture is live.
 *
 * ## Reading 1 — M4: does sustained pressure exist outside the mount storm?
 *
 * Samples `capMisses` through a scripted transport pattern (seeks, scrubs, jumps) and reports the burst
 * distribution. The prior question §6.1 put in front of OQ4: *does the signal have excursions at all?*
 *
 * ## Reading 2 — the corpus half of F2
 *
 * `contribution:scope` proved the timeline-clip path CAN propagate a transform (merit 1.0 / 0.25 / 0.25
 * for full / half-scale / 25%-opacity) while `collectFlarexVirtualLayers` manufactures identity. That is
 * the MECHANISM claim. The corpus claim — does merit actually differ in a live runtime — needs a live
 * fixture, and this one carries it.
 *
 * **The transforms are deliberately VARIED, and that is a measurement decision, not a realism one.**
 * A corpus built all-default is guaranteed to read merit 1.0 for every clip, which tells us nothing and
 * spends the fixture: it cannot distinguish "the mechanism does not discriminate live" from "these
 * particular clips happen to be identical". Whether real projects contain varied transforms is a
 * separate question from whether the mechanism discriminates when they do, and only the second is
 * answerable here. Conflating them is how a guaranteed-null result gets recorded as a finding.
 *
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker playback:contention
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  addAssetSourceMediaIn,
  addMediaInBoundTo,
  awaitWebCodecsEngaged,
  defaultClipPath,
  importAssets,
  reachEditor,
} from "./browser/editor-session";

const SOURCES = Math.max(2, Number(process.env.PROBE_SOURCES ?? 6));
const SECONDS = Number(process.env.PROBE_SECONDS ?? 30);
const SAMPLE_MS = 200;
/** `clips` = real timeline clips (PATH A, merit can vary). `flarex` = virtual sources (PATH B). */
const FIXTURE = (process.env.PROBE_FIXTURE ?? "clips") as "clips" | "flarex";

interface ScoredEntry {
  key: string;
  merit: number;
  rank: number;
  undeclared: boolean;
  residencyProtected: boolean;
  incumbent: boolean;
  admitted: boolean;
  purpose: string | null;
}
interface ScoredDecision {
  capacity: number;
  tieBroken: "rank" | "residency" | "key" | "uncontended";
  boundary: string;
  entries: ScoredEntry[];
  agingAllZero: boolean;
}

function seedClips(count: number): string[] {
  const first = defaultClipPath(SECONDS + 10);
  const dir = path.dirname(first);
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".mp4"))
    .map((n) => path.join(dir, n))
    .filter((f) => fs.statSync(f).size > 0)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  const picked = [first, ...files.filter((f) => f !== first)].slice(0, count);
  if (picked.length < count) throw new Error(`need ${count} distinct clips, found ${picked.length}`);
  return picked;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) {
    console.log("⚠ PIXEL_BROWSER_CHANNEL unset — refusing (P1).");
    process.exit(1);
  }
  let browser: Browser | null = null;
  let context: BrowserContext;
  if (process.env.PROBE_PROFILE) {
    context = await chromium.launchPersistentContext(process.env.PROBE_PROFILE, {
      channel,
      viewport: { width: 1600, height: 900 },
    });
  } else {
    browser = await chromium.launch({ channel });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  }
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    const clips = seedClips(SOURCES);
    const projectUrl = await reachEditor(page, {
      clipPath: clips[0]!,
      flags: "wcDecode=1&kernelDiagnostics=1",
    });
    console.log(`project: ${projectUrl}`);
    console.log(`fixture: ${SOURCES} distinct sources, 4-slot budget, VARIED transforms  [@K=4]\n`);

    await importAssets(page, clips.slice(1));

    let bound = 0;
    let variedCount = 0;
    if (FIXTURE === "flarex") {
      const first = await addAssetSourceMediaIn(page);
      bound = first.ok ? 1 : 0;
      for (let i = 1; i < SOURCES; i += 1) {
        if ((await addMediaInBoundTo(page, i)).ok) bound += 1;
      }
      console.log(`  · Flarex virtual sources bound: ${bound}/${SOURCES}  (PATH B — merit cannot vary)`);
      // `addMediaInBoundTo` ENDS ON THE FLAREX TAB — unlike `addAssetSourceMediaIn`, it does not click
      // back. The timeline ruler does not exist on that page, so the transport pattern found no
      // geometry and the run voided with "no timeline ruler" while the fixture itself was perfect.
      await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
    } else {
      // REAL TIMELINE CLIPS (path A). "Add video only" puts each asset on a NEW TRACK STARTING AT ZERO,
      // so N assets become N clips all active at the same instant — which is what makes them compete.
      for (let i = 1; i < SOURCES; i += 1) {
        const tile = page.locator(".asset-tile").nth(i);
        if (!(await tile.count().catch(() => 0))) continue;
        await tile.hover().catch(() => undefined);
        const add = tile.locator('button[title="Add video only"]').first();
        if (!(await add.count().catch(() => 0))) continue;
        await add.click().catch(() => undefined);
        await page.waitForTimeout(700);
      }
      bound = await page.locator(".timeline-clip").count().catch(() => 0);
      console.log(`  · timeline clips: ${bound}  (PATH A — merit CAN vary)`);

      // VARY THE TRANSFORMS. This is a measurement decision, not a realism one: an all-default corpus
      // is guaranteed to read merit 1.0 for every clip, which cannot distinguish "the mechanism does
      // not discriminate live" from "these clips happen to be identical". Representativeness of real
      // projects is a separate question and is not what this fixture answers.
      const opacities = [90, 70, 50, 30, 15];
      for (let i = 0; i < Math.min(opacities.length, bound - 1); i += 1) {
        const clip = page.locator(".timeline-clip").nth(i + 1);
        if (!(await clip.count().catch(() => 0))) continue;
        await clip.click().catch(() => undefined);
        await page.waitForTimeout(400);
        const input = page.locator('input[aria-label="Opacity value"]').first();
        if (!(await input.count().catch(() => 0))) continue;
        await input.fill(String(opacities[i]!)).catch(() => undefined);
        await input.press("Enter").catch(() => undefined);
        await page.waitForTimeout(350);
        variedCount += 1;
      }
      console.log(`  · transforms varied on ${variedCount} clip(s): opacity ${opacities.slice(0, variedCount).join("/")}`);
    }
    await awaitWebCodecsEngaged(page);

    const readPool = async (): Promise<{ capMisses: number; created: number }> =>
      page.evaluate(() => {
        const p = (globalThis as Record<string, any>).__rfWcPool;
        return { capMisses: Number(p?.capMisses ?? 0), created: Number(p?.created ?? 0) };
      });
    const readScored = async (): Promise<ScoredDecision[]> =>
      page.evaluate(
        () => ((globalThis as Record<string, unknown>).__rfAdmissionScored as ScoredDecision[]) ?? []
      ) as Promise<ScoredDecision[]>;

    const play = page.locator('button[title*="Play"], button[aria-label*="Play"]').first();
    await play.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(2_500);

    const afterStorm = await readPool();
    const stormDecisions = (await readScored()).length;
    console.log(`  · mount storm settled: capMisses ${afterStorm.capMisses}, ${stormDecisions} decisions\n`);

    // ── The transport pattern. This is the instrument. ────────────────────────
    // Seeks force suspended sources to re-acquire against a full pool WHILE the picture is live —
    // the only way this runtime produces contention that is not a mount transient.
    console.log(`  · driving transport for ${SECONDS}s (seek / scrub / jump)…`);
    const box = await page.evaluate(() => {
      const el = document.querySelector(".timeline-ruler");
      if (!(el instanceof HTMLElement)) return null;
      const r = el.getBoundingClientRect();
      return r.width > 20 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
    });
    if (!box) {
      console.log("⚠ VOID — no timeline ruler; the transport pattern could not run.");
      return;
    }

    const series: { t: number; capMisses: number }[] = [];
    const t0 = Date.now();
    let step = 0;
    while (Date.now() - t0 < SECONDS * 1_000) {
      // Alternate long jumps and short scrubs: a long jump abandons in-flight work (I-49's case), a
      // short scrub keeps the same GOP neighbourhood. Both re-acquire; they stress different paths.
      const frac = step % 2 === 0 ? 0.1 + 0.8 * ((step / 2) % 5) / 5 : 0.5 + 0.05 * ((step % 6) - 3);
      const x = box.x + box.width * Math.min(0.95, Math.max(0.05, frac));
      await page.mouse.click(x, box.y + box.height / 2).catch(() => undefined);
      const pool = await readPool();
      series.push({ t: Date.now() - t0, capMisses: pool.capMisses });
      await page.waitForTimeout(SAMPLE_MS);
      step += 1;
    }

    const finalPool = await readPool();
    const all = await readScored();
    const playbackDecisions = all.slice(stormDecisions);

    const wc = await page.evaluate(() => {
      const modes = ((globalThis as Record<string, any>).__rfWcMode ?? {}) as Record<string, string>;
      const values = Object.values(modes);
      return { engaged: values.filter((m) => m !== "element").length, total: values.length };
    });

    console.log(`\n════ playback contention  [@K=4] ════\n`);
    console.log(`precondition (P8)  wcProvider ${wc.engaged}/${wc.total} = ${pct(wc.engaged, wc.total)}`);
    console.log(`transport samples  ${series.length}`);

    // ── READING 1 — M4: is there pressure outside the mount storm? ────────────
    console.log("\n── READING 1 (M4) — does sustained pressure exist during playback?");
    const gained = finalPool.capMisses - afterStorm.capMisses;
    console.log(`   capMisses  ${afterStorm.capMisses} (post-storm) → ${finalPool.capMisses}  =  +${gained} during transport`);
    console.log(`   decisions  ${stormDecisions} during storm · ${playbackDecisions.length} during transport`);

    const deltas: number[] = [];
    for (let i = 1; i < series.length; i += 1) deltas.push(series[i]!.capMisses - series[i - 1]!.capMisses);
    const bursts: number[] = [];
    let run = 0;
    for (const d of deltas) {
      if (d > 0) run += 1;
      else if (run > 0) {
        bursts.push(run * SAMPLE_MS);
        run = 0;
      }
    }
    if (run > 0) bursts.push(run * SAMPLE_MS);
    bursts.sort((a, b) => a - b);
    const p = (q: number): number => (bursts.length === 0 ? 0 : bursts[Math.min(bursts.length - 1, Math.floor(bursts.length * q))]!);

    // CONTENTION-POSSIBILITY GUARD, and it precedes the result.
    //
    // "Pressure never rose" only means something if pressure COULD have risen. A fixture whose sources
    // never exceeded the budget — or never decoded at all — produces `capMisses 0` for a reason that has
    // nothing to do with the runtime's pressure behaviour, and concluding "this runtime has no sustained
    // pressure" from it would be the strongest claim in this document resting on the weakest evidence.
    // Same rule as `capMisses 0` on an uncontended fixture (M0) and one purpose class in M5.
    const couldContend = wc.engaged > 4 || afterStorm.capMisses > 0 || stormDecisions > 0;
    if (!couldContend) {
      console.log("   ⚠ VOID for OQ4 — and NOT a negative result. The fixture never contended at all:");
      console.log(`     wcProvider ${wc.engaged}/${wc.total}, ${afterStorm.capMisses} cap misses at mount, ${stormDecisions} decisions.`);
      console.log("     Fewer sources reached the decode pool than the budget has slots, so `capMisses 0`");
      console.log("     says nothing about whether pressure recurs during playback. This measures the");
      console.log("     FIXTURE, not the runtime — re-run with PROBE_FIXTURE=flarex, which is known to");
      console.log("     put six sources in contention.");
    } else if (gained === 0) {
      console.log("   ⚠ VOID for OQ4 — pressure did NOT rise during transport either.");
      console.log("   The prior question §6.1 put in front of OQ4 is answered NEGATIVELY: this runtime");
      console.log("   has no sustained decode pressure outside the mount storm, even under seeks and");
      console.log("   jumps. A Governor hysteresis constant would have nothing to damp. OQ4 is not");
      console.log("   merely unsized — it is asking about a signal that does not exist here.");
    } else {
      console.log(`   bursts  n=${bursts.length}  p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  max ${bursts[bursts.length - 1] ?? 0}ms`);
      console.log(`   → OQ4's prior question is answered POSITIVELY: pressure DOES recur during`);
      console.log(`     playback. Hysteresis LOWER BOUND := p95 burst = ${p(0.95)}ms.`);
      console.log("   → and the scheduler's acceptance criterion is now testable during playback:");
      console.log("     this transport pattern is the fixture DEBT-011 asks convergence to be measured on.");
    }

    // ── READING 2 — the corpus half of F2 ────────────────────────────────────
    console.log("\n── READING 2 (F2 corpus) — does merit actually differ in a live runtime?");
    const contended = [...all].filter((d) => d.tieBroken !== "uncontended");
    const merits = [...new Set(all.flatMap((d) => d.entries.map((e) => e.merit.toFixed(4))))].sort();
    console.log(`   distinct merits observed across ${all.length} decisions: ${merits.join(", ")}`);
    const tie = (t: string): number => contended.filter((d) => d.tieBroken === t).length;
    console.log(`   tieBroken  rank ${tie("rank")} · residency ${tie("residency")} · key ${tie("key")}`);

    if (FIXTURE === "clips" && variedCount === 0) {
      console.log("   ⚠ VOID for the corpus reading — no transform was varied, so merit was guaranteed");
      console.log("     identical and this cannot distinguish a non-discriminating mechanism from an");
      console.log("     undifferentiated corpus. The opacity control was not reachable.");
    } else if (merits.length <= 1) {
      if (FIXTURE === "flarex") {
        console.log("   → CORPUS CONFIRMS THE MECHANISM FINDING for PATH B: every virtual source scored");
        console.log("     the same merit, exactly as `contribution:scope` predicts — the identity");
        console.log("     transform is stamped at synthesis, so no product action can differentiate");
        console.log("     them. Live runtime agrees with the pure-function check.");
      } else {
        console.log("   ⚠ UNEXPECTED — transforms WERE varied on real timeline clips and merit is still");
        console.log("     uniform. `contribution:scope` says path A propagates, so either the variation");
        console.log("     did not reach the layer or these candidates are not the varied clips.");
        console.log("     Do NOT read this as a path-A finding without resolving which.");
      }
    } else {
      console.log(`   → merit DOES differ live on PATH A: ${merits.length} distinct values.`);
      console.log("     The mechanism discriminates in the running editor, not only as a pure function,");
      console.log("     so F2 is confirmed BOUNDED from the live side as well.");
    }

    console.log("\n(Every figure above is @K=4 and provisional until M7 confirms K — §4.2.)\n");
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

const exitTimer = setTimeout(() => process.exit(0), 12 * 60_000);
exitTimer.unref();

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
