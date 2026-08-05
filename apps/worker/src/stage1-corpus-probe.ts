/**
 * ADR-013 Phase 0 / Stage 1 — one instrumented corpus run answering M1, M4 and M5.
 *
 * Three questions off one run, because they read the same evidence: M1 (OQ1, rank weights) and M5
 * (OQ5, reservation granularity) are both computed from `__rfAdmissionScored`, and M4 (OQ4, the
 * pressure signal's own statistics) is differenced from `__rfWcPool`'s unconditional counters. Running
 * them separately would triple the browser time and — worse — measure three different machine states.
 *
 * ## Preconditions this run enforces, and why each is here
 *
 *   P1  chrome channel. Without it this is SwiftShader at ~8fps and no race reproduces.
 *   P7  fps is NOT read as a comparand (DEBT-011). This probe does not report frame rate at all.
 *   P8  `wcProvider %` is the precondition instrument. `awaitWebCodecsEngaged` tests
 *       `.some(mode !== "element")`, so one engaged source of six satisfies it — a liveness check, not
 *       a comparability check.
 *
 * ## The vacuity guard, declared before the measurement
 *
 * A contended decision is one where candidates exceeded capacity. If none occurred, every M1 and M5
 * ratio is 0/0 and the run says nothing — which is indistinguishable from "rank always discriminates"
 * or "contention is always cross-class" unless it is checked. Same rule as `detaches 0 · blindSplits 0`
 * being VOID. This probe refuses to report ratios when `contended === 0`.
 *
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker stage1:corpus
 *   PROBE_SOURCES=6   distinct files bound as asset-source MediaIns (default 6)
 *   PROBE_SECONDS=20  playback sampled after warmup
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
const SECONDS = Number(process.env.PROBE_SECONDS ?? 20);
const WARMUP_MS = 1_500;
/** How often the pressure series is sampled. M4 differences these into bursts. */
const PRESSURE_SAMPLE_MS = 250;

interface ScoredEntry {
  key: string;
  merit: number;
  aging: number;
  rank: number;
  undeclared: boolean;
  residencyProtected: boolean;
  incumbent: boolean;
  admitted: boolean;
  deniedForMs: number;
  purpose: string | null;
}
interface ScoredDecision {
  capacity: number;
  tieBroken: "rank" | "residency" | "key" | "uncontended";
  boundary: "declared" | "undeclared" | "mixed" | "none";
  entries: ScoredEntry[];
  agingAllZero: boolean;
  incumbentDeniedForMsIsResidency: boolean;
}
interface PressureSample {
  t: number;
  capMisses: number;
  created: number;
  shareDetaches: number;
  wedgeTimeouts: number;
  active: number;
}

function seedClips(count: number): string[] {
  const first = defaultClipPath(SECONDS + 8);
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

async function readScored(page: Page): Promise<ScoredDecision[]> {
  return page.evaluate(
    () => ((globalThis as Record<string, unknown>).__rfAdmissionScored as ScoredDecision[]) ?? []
  ) as Promise<ScoredDecision[]>;
}

async function readPressure(page: Page): Promise<PressureSample | null> {
  return page.evaluate(() => {
    const pool = (globalThis as Record<string, any>).__rfWcPool;
    if (!pool) return null;
    return {
      t: performance.now(),
      capMisses: Number(pool.capMisses ?? 0),
      created: Number(pool.created ?? 0),
      shareDetaches: Number(pool.shareDetaches ?? 0),
      wedgeTimeouts: Number(pool.wedgeTimeouts ?? 0),
      active: Number(pool.active ?? 0),
    };
  });
}

/** P8: the comparability reading. Fraction of sampled sources actually on a WebCodecs provider. */
async function readWcProvider(page: Page): Promise<{ engaged: number; total: number }> {
  return page.evaluate(() => {
    const modes = ((globalThis as Record<string, any>).__rfWcMode ?? {}) as Record<string, string>;
    const values = Object.values(modes);
    return { engaged: values.filter((m) => m !== "element").length, total: values.length };
  });
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) {
    console.log("⚠ PIXEL_BROWSER_CHANNEL is unset — this would run SwiftShader at ~8fps. Refusing (P1).");
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
    const projectUrl = await reachEditor(page, { clipPath: clips[0]!, flags: "wcDecode=1&kernelDiagnostics=1" });
    console.log(`project: ${projectUrl}`);
    console.log(`fixture: ${SOURCES} distinct sources against a 4-slot budget  [@K=4]\n`);

    const tiles = await importAssets(page, clips.slice(1));
    console.log(`  · asset bin: ${tiles} tile(s)`);
    const first = await addAssetSourceMediaIn(page);
    console.log(`  · MediaIn 1: ${first.ok ? "bound" : `FAILED at gate \`${first.gate}\``}`);
    let bound = first.ok ? 1 : 0;
    for (let i = 1; i < SOURCES; i += 1) {
      const extra = await addMediaInBoundTo(page, i);
      if (extra.ok) bound += 1;
      console.log(`  · MediaIn ${i + 1}: ${extra.ok ? "bound" : `FAILED at gate \`${extra.gate}\``}`);
    }
    console.log(`  · sources bound: ${bound}/${SOURCES}`);

    // Liveness only (P8) — the comparability reading comes from wcProvider below.
    const live = await awaitWebCodecsEngaged(page);
    console.log(`  · webcodecs liveness: ${live ? "something engaged" : "NOTHING engaged"}`);

    const play = page.locator('button[title*="Play"], button[aria-label*="Play"]').first();
    await play.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(WARMUP_MS);

    const series: PressureSample[] = [];
    const deadline = Date.now() + SECONDS * 1_000;
    while (Date.now() < deadline) {
      const sample = await readPressure(page);
      if (sample) series.push(sample);
      await page.waitForTimeout(PRESSURE_SAMPLE_MS);
    }

    const wc = await readWcProvider(page);
    const scored = await readScored(page);

    console.log(`\n════ Stage 1 — M1 · M4 · M5   [@K=4] ════\n`);
    console.log(`precondition (P8)  wcProvider ${wc.engaged}/${wc.total} sources = ${pct(wc.engaged, wc.total)}`);
    if (wc.total > 0 && wc.engaged < wc.total) {
      console.log(`                   ⚠ not all declared sources decoded through WebCodecs — see DEBT-011`);
    }
    console.log(`pressure samples   ${series.length} over ${SECONDS}s at ${PRESSURE_SAMPLE_MS}ms`);
    console.log(`scored decisions   ${scored.length} recorded\n`);

    // ── VACUITY GUARD ───────────────────────────────────────────────────────
    const contended = scored.filter((d) => d.tieBroken !== "uncontended");
    if (scored.length === 0) {
      console.log("⚠ VOID — no scored decision was recorded at all. Either diagnostics were off, or");
      console.log("        `reportAdmissionDenial` was never reached (no cap miss occurred).");
      return;
    }
    if (contended.length === 0) {
      console.log("⚠ VOID for M1 and M5 — decisions were recorded but NONE was contended.");
      console.log("        Every ratio below would be 0/0, which is indistinguishable from a clean result.");
      return;
    }

    // ── C1 / C2 assertions ──────────────────────────────────────────────────
    const c1Fail = scored.filter((d) => !d.agingAllZero).length;
    const c2Fail = scored.filter((d) => !d.incumbentDeniedForMsIsResidency).length;
    console.log("── assertions (the premises Stage 1's analysis rests on)");
    console.log(`   C1 aging-all-zero          ${c1Fail === 0 ? "HOLDS" : `VIOLATED in ${c1Fail}/${scored.length}`}`);
    console.log(
      `   C2 incumbent=residency     ${c2Fail === 0 ? "HOLDS" : `VIOLATED in ${c2Fail}/${scored.length}`}`
    );
    if (c2Fail > 0) console.log("   ⚠ M5's census split is built on C2 — re-derive it before applying the decision rule.");

    // ── M1 ──────────────────────────────────────────────────────────────────
    const declared = contended.filter((d) => d.boundary === "declared");
    const undeclaredB = contended.filter((d) => d.boundary === "undeclared");
    const mixed = contended.filter((d) => d.boundary === "mixed");
    const tKey = declared.filter((d) => d.tieBroken === "key").length;
    const tRank = declared.filter((d) => d.tieBroken === "rank").length;
    const tRes = declared.filter((d) => d.tieBroken === "residency").length;
    const allEntries = scored.flatMap((d) => d.entries);
    const undeclaredEntries = allEntries.filter((e) => e.undeclared).length;

    console.log("\n── M1 (OQ1) — does rank separate competitors?");
    console.log(`   contended decisions        ${contended.length} of ${scored.length}`);
    console.log(`   boundary  declared ${declared.length} · undeclared ${undeclaredB.length} · mixed ${mixed.length}`);
    console.log(`   T_declared (key-decided)   ${tKey}/${declared.length} = ${pct(tKey, declared.length)}`);
    console.log(`     …rank-decided            ${tRank}/${declared.length} = ${pct(tRank, declared.length)}`);
    console.log(`     …residency-decided       ${tRes}/${declared.length} = ${pct(tRes, declared.length)}`);
    console.log(
      `   T_undeclared (key-decided) ${undeclaredB.filter((d) => d.tieBroken === "key").length}/${undeclaredB.length}` +
        `  — reported separately, never summed into T_declared`
    );
    console.log(`   U (undeclared candidates)  ${undeclaredEntries}/${allEntries.length} = ${pct(undeclaredEntries, allEntries.length)}`);

    // The rule is read over ALL THREE comparator levels, per the 2026-08-05 amendment. Reading a low
    // `key` share as evidence that RANK discriminated is the defect that amendment corrects: not-`key`
    // means rank OR residency, and those are opposite findings. The instrument was built tri-valued
    // precisely so this could not be conflated; the first rule was written as if it were not.
    const keyShare = declared.length === 0 ? 0 : tKey / declared.length;
    const rankShare = declared.length === 0 ? 0 : tRank / declared.length;
    const resShare = declared.length === 0 ? 0 : tRes / declared.length;
    const uRatio = allEntries.length === 0 ? 0 : undeclaredEntries / allEntries.length;
    console.log("\n   VERDICT against the pre-registered rule (as amended 2026-08-05):");
    if (declared.length === 0) {
      console.log("     INCONCLUSIVE — no contended decision had a declared/declared boundary.");
    } else if (keyShare >= 0.5) {
      console.log("     ROW 1 — key share >= 0.5. OQ1 IS MISPOSED: weights are not the open question,");
      console.log("     the derivation of `area` is. Rewrite OQ1 as 'derive area from coverage and");
      console.log("     occlusion'; defer weight tuning behind it.");
    } else if (rankShare >= 0.5 && uRatio <= 0.15) {
      console.log("     ROW 2 — rank genuinely discriminates. Weights are a real tuning surface → M1b.");
    } else if (resShare >= 0.5) {
      console.log("     ROW 3 — RANK IS INOPERATIVE AT THE MOMENT CONTENTION OCCURS.");
      console.log("     Minimum residency is the operative admission policy: every contended decision was");
      console.log("     settled by the clock, not by merit. Tuning weights is pointless until the");
      console.log("     residency window is reconciled with WHEN contention actually happens.");
      console.log("     Read with C1: aging never fires either, so neither merit nor fairness arbitrates");
      console.log("     the only contention this fixture produces.");
    } else {
      console.log("     ROW 4 — INCONCLUSIVE. Widen the corpus; do not default.");
    }
    if (uRatio >= 0.5) {
      console.log("     ⚠ FALSIFIER FIRED: U >= 0.5. I-48 is satisfied only vacuously — most consumers");
      console.log("       never declare a contribution. This is a wiring defect and changes slice 1.");
    }

    // ── M5 ──────────────────────────────────────────────────────────────────
    const denialEntries = contended.flatMap((d) => d.entries.filter((e) => !e.admitted));
    const incumbentDenied = denialEntries.filter((e) => e.incumbent).length;
    console.log("\n── M5 (OQ5) — who contends with whom?");
    console.log(`   denied candidates          ${denialEntries.length}`);
    console.log(`   …incumbent (displaced)     ${incumbentDenied} = ${pct(incumbentDenied, denialEntries.length)}`);
    console.log(`   …newcomer (refused)        ${denialEntries.length - incumbentDenied}`);

    // C15 purpose class, threaded 2026-08-05. A denial is INTRA-class when the denied candidate and
    // everything that displaced it share a purpose: a per-class reservation cannot express protection
    // in that case, so a high share means per-class reserves are insufficient rather than just simpler.
    let intra = 0;
    let cross = 0;
    let unclassifiable = 0;
    for (const decision of contended) {
      const admittedPurposes = decision.entries.filter((e) => e.admitted).map((e) => e.purpose);
      for (const denied of decision.entries.filter((e) => !e.admitted)) {
        if (denied.purpose == null || admittedPurposes.some((p) => p == null)) {
          unclassifiable += 1;
        } else if (admittedPurposes.every((p) => p === denied.purpose)) {
          intra += 1;
        } else {
          cross += 1;
        }
      }
    }
    const classified = intra + cross;
    console.log(`   intra-class denials        ${intra}/${classified} = ${pct(intra, classified)}`);
    console.log(`   cross-class denials        ${cross}/${classified} = ${pct(cross, classified)}`);
    console.log(`   unclassifiable (undeclared purpose)  ${unclassifiable}`);

    // VACUITY GUARD — purpose DIVERSITY, not merely purpose presence.
    //
    // The intra/cross split is only meaningful if a cross-class denial was POSSIBLE. On a fixture where
    // every candidate carries one purpose, "100% intra-class" is arithmetic, not evidence: there was no
    // other class to lose to. This is the same shape as `capMisses 0` on an uncontended fixture and as
    // `U = 0.0%` on a fabricated-declaration path — a number that reads decisive because the
    // alternative was unreachable.
    const purposesSeen = new Set(
      contended.flatMap((d) => d.entries.map((e) => e.purpose)).filter((p): p is string => p != null)
    );
    console.log(`   distinct purposes present  ${purposesSeen.size} {${[...purposesSeen].join(", ")}}`);

    console.log("\n   VERDICT against the pre-registered rule:");
    if (classified === 0) {
      console.log("     ⚠ VOID — no denial could be classified. Every candidate's purpose is undeclared,");
      console.log("     so the intra-class share is 0/0. Undeclared is NOT defaulted to `live`: doing so");
      console.log("     would manufacture the very intra-class contention this measures (DEBT-012).");
    } else if (purposesSeen.size < 2) {
      console.log("     ⚠ VOID — only ONE purpose class was present, so a cross-class denial was");
      console.log("     impossible and the 100% intra-class share is arithmetic rather than evidence.");
      console.log("     C15 now carries purpose faithfully; what is missing is DIVERSITY in the");
      console.log("     workload. Every acquisition through this pool today is `live` — background");
      console.log("     work (proxy builds, thumbnails) does not take decode sessions through this");
      console.log("     path — so OQ5's per-class-vs-per-source question has no competing classes to");
      console.log("     arbitrate between yet, and cannot be answered on this runtime as it stands.");
    } else {
      const iShare = intra / classified;
      if (iShare < 0.1) {
        console.log("     PER-CLASS is sufficient — intra-class share < 10%. Record the measured value");
        console.log("     as the justification for the simpler design.");
      } else if (iShare > 0.3) {
        console.log("     PER-SOURCE IS REQUIRED — intra-class share > 30%. A per-class reserve cannot");
        console.log("     see the contention it exists to arbitrate.");
      } else {
        console.log("     INCONCLUSIVE (0.10–0.30). Widen the corpus; do NOT default to the simpler");
        console.log("     option because it is simpler.");
      }
    }
    if (denialEntries.length > 0 && contended.length > 0) {
      // The absolute-rarity falsifier: reservations may be solving a problem this workload lacks.
      console.log(`   (contended decisions were ${contended.length} of ${scored.length} recorded)`);
    }

    // ── M4 ──────────────────────────────────────────────────────────────────
    console.log("\n── M4 (OQ4) — the pressure signal's own statistics");
    if (series.length < 2) {
      console.log("   ⚠ VOID — fewer than two pressure samples.");
    } else {
      const deltas: number[] = [];
      for (let i = 1; i < series.length; i += 1) {
        deltas.push(series[i]!.capMisses - series[i - 1]!.capMisses);
      }
      const active = deltas.filter((d) => d > 0).length;
      // A burst is a maximal run of consecutive samples with capMisses rising.
      const bursts: number[] = [];
      let run = 0;
      for (const d of deltas) {
        if (d > 0) run += 1;
        else if (run > 0) {
          bursts.push(run * PRESSURE_SAMPLE_MS);
          run = 0;
        }
      }
      if (run > 0) bursts.push(run * PRESSURE_SAMPLE_MS);
      bursts.sort((a, b) => a - b);
      const p = (q: number): number => (bursts.length === 0 ? 0 : bursts[Math.min(bursts.length - 1, Math.floor(bursts.length * q))]!);
      console.log(`   capMisses  ${series[0]!.capMisses} → ${series[series.length - 1]!.capMisses}`);
      console.log(`   samples with rising pressure  ${active}/${deltas.length} = ${pct(active, deltas.length)}`);
      console.log(`   bursts  n=${bursts.length}  p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  max ${bursts[bursts.length - 1] ?? 0}ms`);
      console.log(`   wedgeTimeouts ${series[series.length - 1]!.wedgeTimeouts} · detaches ${series[series.length - 1]!.shareDetaches}`);
      if (bursts.length === 0) {
        console.log("   ⚠ VOID for the hysteresis lower bound — pressure never rose during the window.");
        console.log("     All contention happened before sampling started (mount storm), so there is no");
        console.log("     burst distribution to size a constant against.");
      } else {
        console.log(`   → hysteresis LOWER BOUND := p95 burst = ${p(0.95)}ms (M8 supplies the upper).`);
      }
    }

    console.log("\n(Every figure above is @K=4 and provisional until M7 confirms K — §4.2.)\n");
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

// Unref'd backstop: a probe that prints a complete report and then hangs forever is worse than one
// that crashes, because the measurement looks finished while the process wedges.
const exitTimer = setTimeout(() => process.exit(0), 10 * 60_000);
exitTimer.unref();

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
