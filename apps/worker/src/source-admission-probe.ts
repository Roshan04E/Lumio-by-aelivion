/**
 * S4.3 — SOURCE ADMISSION SOAK.
 *
 * Done when: *"denial is observable in diagnostics for over-budget comps"* (programme §S4.3).
 *
 * The slice's testing clause asks for two arrangements, and they are opposites on purpose:
 *
 *  - **OVER budget** (default 8 MediaIns against a 4-slot cap): denials must be REPORTED. Admission is
 *    behaviour-neutral until S4.5, so the assertion is about visibility, not about who won.
 *  - **UNDER budget** (`PROBE_SOURCES=3`) with divergent trajectories: no session churn. The clause is
 *    explicit that hysteresis "damps oscillation, not badness, and must never be relied on to correct a
 *    grant that should not have been made", so a run that churns under budget fails even with denials
 *    reported correctly.
 *
 * WHY A SEPARATE PROBE from `preview-budget-probe`. That one measures a FRAME BUDGET across two arms and
 * builds a one-source fixture with a cut. This one measures a DECODER budget and needs many distinct
 * sources; folding them together would give a fixture that serves neither and arms that vary two things
 * at once.
 *
 * VOID rather than pass. The failure this file exists to avoid is a comp that never went over budget
 * reporting "0 denials" as a success — an assertion satisfied by an absence. `capMisses` is the
 * independent witness that the budget was actually exceeded, so a run with no cap miss is void, not
 * green.
 */
import { chromium, type Browser, type BrowserContext } from "playwright";
import fs from "node:fs";
import path from "node:path";
import {
  addAssetSourceMediaIn,
  addMediaInBoundTo,
  awaitWebCodecsEngaged,
  defaultClipPath,
  importAssets,
  reachEditor,
  reopenWithFlags,
} from "./browser/editor-session.js";

const SOURCES = Math.max(1, Number(process.env.PROBE_SOURCES ?? 8));
const SECONDS = Number(process.env.PROBE_SECONDS ?? 12);
const WARMUP_MS = Number(process.env.PROBE_WARMUP_MS ?? 1_500);
/** The decoder budget this fixture is built to exceed. Read from the product, not assumed, where possible. */
const NOMINAL_CAP = 4;

const ARMS = [
  { name: "inherited first-come admission", flags: "kernelSourceAdmission=0" },
  { name: "S4.3 ranked admission", flags: "kernelSourceAdmission=1" },
];

interface PoolSnapshot {
  created: number;
  capMisses: number;
  admissionDenials: number;
  admissionPreemptions: number;
  shared: number;
  shareDetaches: number;
}

async function readPool(page: import("playwright").Page): Promise<PoolSnapshot | null> {
  return page.evaluate(() => {
    const pool = (globalThis as Record<string, any>).__rfWcPool;
    if (!pool) return null;
    return {
      created: Number(pool.created ?? 0),
      capMisses: Number(pool.capMisses ?? 0),
      admissionDenials: Number(pool.admissionDenials ?? 0),
      admissionPreemptions: Number(pool.admissionPreemptions ?? 0),
      shared: Number(pool.shared ?? 0),
      shareDetaches: Number(pool.shareDetaches ?? 0),
    };
  });
}

/**
 * Distinct seed files. `defaultClipPath` returns ONE clip (the smallest long-enough one); admission
 * needs many, and they must differ — see {@link importAssets}.
 */
function seedClips(count: number): string[] {
  const first = defaultClipPath();
  const dir = path.dirname(first);
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  const picked = [first, ...files.filter((f) => f !== first)].slice(0, count);
  if (picked.length < count) {
    throw new Error(`need ${count} distinct clips, found ${picked.length} in ${dir}`);
  }
  return picked;
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
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
  console.log(`target: ${SOURCES} distinct sources against a ${NOMINAL_CAP}-slot budget`);

  if (!(await awaitWebCodecsEngaged(page))) {
    console.log("[admission] ⚠ VOID — the WebCodecs path never engaged; the decoder budget is not the one under test.");
  }

  const tiles = await importAssets(page, clips.slice(1));
  console.log(`  · asset bin: ${tiles} tile(s) after import`);

  const first = await addAssetSourceMediaIn(page);
  console.log(`  · MediaIn 1: ${first.ok ? `bound → ${first.detail ?? "?"}` : `FAILED at gate \`${first.gate}\``}`);
  let bound = first.ok ? 1 : 0;
  for (let i = 1; i < SOURCES; i += 1) {
    // Tile index i: tile 0 is the host clip, already taken by `addAssetSourceMediaIn` above.
    const result = await addMediaInBoundTo(page, i);
    if (result.ok) bound += 1;
    console.log(
      `  · MediaIn ${i + 1}: ${result.ok ? `bound → ${result.detail ?? "?"}` : `FAILED at gate \`${result.gate}\``}`
    );
  }
  console.log(`sources bound: ${bound}/${SOURCES}`);

  const results: { name: string; pool: PoolSnapshot | null; applied?: string | null }[] = [];
  for (const arm of ARMS) {
    console.log(`  · ${arm.name}: reloading with ?${arm.flags}&wcDecode=1`);
    await reopenWithFlags(page, projectUrl, `${arm.flags}&wcDecode=1`);
    const play = page.locator('button[title*="Play"], button[aria-label*="Play"]').first();
    await play.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(WARMUP_MS + SECONDS * 1_000);
    // PROVE THE FLAG APPLIED. Both arms reporting identical counters is the signature of a switch that
    // never reached the page, and it is indistinguishable from a switch that reached it and changed
    // nothing — which is the expected result here, since admission is behaviour-neutral until S4.5.
    // Reading the value the PAGE saw is what separates those two, so the null result stays falsifiable.
    const applied = await page.evaluate(
      () => new URLSearchParams(window.location.search).get("kernelSourceAdmission")
    );
    console.log(`  · ${arm.name}: page saw kernelSourceAdmission=${applied ?? "ABSENT"}`);
    results.push({ name: `${arm.name}   [?${arm.flags}]`, pool: await readPool(page), applied });
    console.log(`  · ${arm.name}: done`);
  }

  console.log("\n════ source admission ════");
  for (const r of results) {
    console.log(`\n── ${r.name}`);
    if (!r.pool) {
      console.log("   pool     UNAVAILABLE — __rfWcPool absent; nothing can be concluded from this arm.");
      continue;
    }
    const p = r.pool;
    console.log(
      `   decoder  created ${p.created} · capMisses ${p.capMisses} · shared ${p.shared} · detaches ${p.shareDetaches}`
    );
    console.log(`   admission denials ${p.admissionDenials} · preemptions ${p.admissionPreemptions}`);
  }

  // ── THE DONE-WHEN, and its vacuity guard.
  // A null result is only evidence if the switch was actually thrown. An arm whose page never saw the
  // flag is void for the comparison regardless of how clean its counters look.
  const flagsApplied = results.every((r, i) => r.applied === (ARMS[i]!.flags.endsWith("=1") ? "1" : "0"));
  if (!flagsApplied) {
    console.log(
      `\n[admission] ⚠ VOID — an arm's page did not see the flag it was supposed to run under ` +
        `(${results.map((r) => r.applied ?? "ABSENT").join(" · ")}).\n` +
        "            Identical arms mean nothing until the switch is known to have reached the page."
    );
    process.exitCode = 1;
  }

  const overBudget = bound > NOMINAL_CAP;
  const exceeded = results.some((r) => (r.pool?.capMisses ?? 0) > 0);
  const reported = results.some((r) => (r.pool?.admissionDenials ?? 0) > 0);

  if (!overBudget) {
    // UNDER-BUDGET ARRANGEMENT: the churn question, not the denial one.
    const churned = results.some((r) => (r.pool?.admissionPreemptions ?? 0) > 0);
    console.log(
      churned
        ? `\n[admission] ✗ FAIL — ${bound} sources fit a ${NOMINAL_CAP}-slot budget yet admission still took slots.\n` +
            "            Hysteresis damps oscillation, not badness; a preemption here is a grant that should\n" +
            "            not have been made, not one that needed correcting."
        : `\n[admission] ✓ under budget (${bound} ≤ ${NOMINAL_CAP}) and no session churn — hysteresis is not load-bearing.`
    );
    if (churned) process.exitCode = 1;
  } else if (!exceeded) {
    console.log(
      `\n[admission] ⚠ VOID — ${bound} sources were bound but the budget was never actually exceeded\n` +
        "            (capMisses 0 in every arm). '0 denials' here is an absence of evidence, not a pass:\n" +
        "            the sources may never have mounted together. Lengthen PROBE_SECONDS or check binding."
    );
  } else if (!reported) {
    console.log(
      "\n[admission] ✗ FAIL — the budget was exceeded (capMisses > 0) but no denial was reported.\n" +
        "            That is exactly the done-when: over-budget comps must make denial observable."
    );
    process.exitCode = 1;
  } else {
    const gaps = results
      .filter((r) => r.pool)
      .map((r) => `${r.pool!.capMisses - r.pool!.admissionDenials}`)
      .join(" · ");
    console.log(
      `\n[admission] ✓ DONE-WHEN MET — over budget, and denial is observable in diagnostics.\n` +
        `            capMisses−denials per arm: ${gaps}. A positive gap means producers are still not\n` +
        "            declaring: ranking cannot attribute a miss it never saw, so that is wiring to chase,\n" +
        "            not a passing detail."
    );
  }

  const closed = (async () => {
    await context.close();
    await browser?.close();
  })();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 15_000))]).catch(() => undefined);
}

main()
  .then(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 5_000).unref();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
