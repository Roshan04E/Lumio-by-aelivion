/**
 * ADR-013 Phase 0 — the falsifiability check M1's result is gated on.
 *
 * ## The question
 *
 * Stage 1 measured `rank` deciding **0 of 8** contended admissions, with minimum residency deciding all
 * eight. That single number cannot distinguish two worlds with very different fixes:
 *
 *   A — rank is INOPERATIVE because residency preempts it. Fix: reconcile the residency window with
 *       when contention actually happens (OQ9).
 *   B — rank NEVER DECIDES because rank scoring is not correctly wired. Fix: the wiring. M1's Row 3
 *       would then mean something else entirely.
 *
 * The standing rule is *prove the instrument can tell the answers apart*. So: force a contended decision
 * where residency CANNOT apply, with candidates whose merit genuinely differs, and see whether `rank`
 * decides. If it does, world A. If it still does not, world B, and M1's result is retracted.
 *
 * ## How residency is broken WITHOUT touching MIN_RESIDENCY_MS
 *
 * The constant is not changed — changing a mechanism in the middle of a measurement programme is how a
 * programme loses the ability to interpret its own numbers, and it is explicitly deferred (OQ9).
 *
 * Instead the check exploits residency's own definition: protection lapses `MIN_RESIDENCY_MS` after
 * admission. The probe binds its sources, then **waits past the window** so every incumbent is
 * unprotected, and only then forces fresh contention. Same mechanism, same constant, a moment where it
 * provably cannot be the deciding term.
 *
 * ## Why merit must be made to DIFFER, and why this is the sharper half of the check
 *
 * `contributionRank` is `area × opacity`, and `area` is `min(1, scale²)` from the layer transform. Every
 * MediaIn in the Stage 1 fixture carries a default transform, so **every merit is exactly 1.0** — and a
 * decision between equal merits falls to the `key` comparator by construction, outside the residency
 * window as well as inside it.
 *
 * That means a naive "wait and retry" check would report `key` and prove nothing: it cannot separate
 * "rank is wired but had nothing to discriminate" from "rank is broken". So the probe drives the
 * opacity of some sources DOWN, which is the one ranking input reachable from the product UI, and
 * expects the ordering to follow merit. Two outcomes, both informative:
 *
 *   · `tieBroken: "rank"` and the low-opacity sources are the ones denied → world A. Rank works; it is
 *     simply never consulted, because residency has already decided by the time contention occurs.
 *   · `tieBroken: "key"` with merits that visibly differ in the record → world B. The scores differ and
 *     the ordering ignored them, which is a wiring defect.
 *
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker residency:falsify
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

const SOURCES = Math.max(3, Number(process.env.PROBE_SOURCES ?? 6));
/** Comfortably past MIN_RESIDENCY_MS (1000ms). Read from the kernel, never re-declared here. */
const RESIDENCY_WAIT_MS = Number(process.env.PROBE_RESIDENCY_WAIT_MS ?? 6_000);

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
}
interface ScoredDecision {
  capacity: number;
  tieBroken: "rank" | "residency" | "key" | "uncontended";
  boundary: "declared" | "undeclared" | "mixed" | "none";
  entries: ScoredEntry[];
  agingAllZero: boolean;
  incumbentDeniedForMsIsResidency: boolean;
}

function seedClips(count: number): string[] {
  const first = defaultClipPath(30);
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

/**
 * Drive opacity down on some Flarex MediaIn nodes so merit differs.
 *
 * Reaches through the editor's own store rather than clicking, because the target is a ranking INPUT
 * and not a UI affordance under test — and a slider drag that silently misses would report a null
 * result identical to a broken ranker, which is the failure this whole probe exists to avoid.
 */
async function dimSources(page: Page, fraction: number): Promise<number> {
  return page.evaluate((frac) => {
    const store = (globalThis as Record<string, any>).__rfx ?? (globalThis as Record<string, any>).lumio;
    const api = store?.editorStore ?? store;
    if (!api?.getState) return -1;
    const state = api.getState();
    const comps = state?.composition?.flarexComps ?? state?.flarexComps;
    if (!comps) return -1;
    let dimmed = 0;
    for (const comp of Object.values(comps) as any[]) {
      const nodes = comp?.nodes ?? [];
      const mediaIns = nodes.filter((n: any) => n?.type === "MediaIn" && n?.params?.sourceAssetId);
      const target = Math.floor(mediaIns.length * frac);
      for (let i = 0; i < target; i += 1) {
        const node = mediaIns[i];
        if (!node) continue;
        node.params = { ...node.params, opacity: 5 };
        dimmed += 1;
      }
    }
    return dimmed;
  }, fraction);
}

function summarise(label: string, decisions: readonly ScoredDecision[]): void {
  const contended = decisions.filter((d) => d.tieBroken !== "uncontended");
  console.log(`\n── ${label}`);
  console.log(`   decisions ${decisions.length} · contended ${contended.length}`);
  if (contended.length === 0) {
    console.log("   (nothing contended in this phase)");
    return;
  }
  const by = (t: string): number => contended.filter((d) => d.tieBroken === t).length;
  console.log(`   tieBroken  rank ${by("rank")} · residency ${by("residency")} · key ${by("key")}`);
  const anyProtected = contended.some((d) => d.entries.some((e) => e.residencyProtected));
  console.log(`   any residency-protected candidate present: ${anyProtected}`);
  const merits = [...new Set(contended.flatMap((d) => d.entries.map((e) => e.merit.toFixed(4))))].sort();
  console.log(`   distinct merits observed: ${merits.join(", ")}`);
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) {
    console.log("⚠ PIXEL_BROWSER_CHANNEL is unset — refusing (P1).");
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
    console.log("falsifiability check — can `rank` decide anything at all?  [@K=4]\n");

    await importAssets(page, clips.slice(1));
    const first = await addAssetSourceMediaIn(page);
    let bound = first.ok ? 1 : 0;
    for (let i = 1; i < SOURCES; i += 1) {
      if ((await addMediaInBoundTo(page, i)).ok) bound += 1;
    }
    console.log(`  · sources bound: ${bound}/${SOURCES}`);
    await awaitWebCodecsEngaged(page);

    const play = page.locator('button[title*="Play"], button[aria-label*="Play"]').first();
    await play.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(3_000);

    const phase1 = await readScored(page);
    summarise("PHASE 1 — the mount storm (residency window OPEN)", phase1);

    // ── Break residency by outliving it, and make merit differ ────────────────
    console.log(`\n  · waiting ${RESIDENCY_WAIT_MS}ms so every incumbent outlives MIN_RESIDENCY_MS…`);
    await page.waitForTimeout(RESIDENCY_WAIT_MS);
    const dimmed = await dimSources(page, 0.5);
    console.log(`  · merit differentiation: ${dimmed < 0 ? "COULD NOT REACH THE STORE" : `${dimmed} source(s) dimmed`}`);

    // Force fresh contention: a hard scrub makes suspended sources re-acquire against a full pool.
    console.log("  · forcing contention by scrubbing…");
    const ruler = page.locator(".timeline-ruler").first();
    const box = await ruler.boundingBox().catch(() => null);
    if (box) {
      for (let i = 0; i < 12; i += 1) {
        const x = box.x + box.width * (0.15 + 0.7 * ((i % 5) / 5));
        await page.mouse.click(x, box.y + box.height / 2).catch(() => undefined);
        await page.waitForTimeout(220);
      }
    }
    await page.waitForTimeout(1_500);

    const all = await readScored(page);
    const phase2 = all.slice(phase1.length);
    summarise("PHASE 2 — after the window lapsed, merit differentiated", phase2);

    // ── VERDICT ──────────────────────────────────────────────────────────────
    console.log("\n════ VERDICT ════");
    const contended2 = phase2.filter((d) => d.tieBroken !== "uncontended");
    const rankDecided = contended2.filter((d) => d.tieBroken === "rank").length;
    const meritsDiffer = contended2.some((d) => {
      const set = new Set(d.entries.map((e) => e.merit.toFixed(4)));
      return set.size > 1;
    });

    if (contended2.length === 0) {
      console.log("⚠ VOID — phase 2 produced no contended decision, so the check did not run.");
      console.log("  The scrub did not force a cap miss. M1's Row 3 stays PROVISIONAL; retry with a");
      console.log("  harsher transport pattern or more sources than the budget.");
    } else if (!meritsDiffer) {
      console.log("⚠ VOID — phase 2 contended, but every candidate still scored the SAME merit.");
      console.log("  A decision between equal merits falls to `key` by construction, so this cannot");
      console.log("  separate 'rank works but had nothing to discriminate' from 'rank is broken'.");
      console.log(`  Merit differentiation ${dimmed < 0 ? "could not reach the store" : "did not take effect"}.`);
      console.log("  M1's Row 3 stays PROVISIONAL.");
    } else if (rankDecided > 0) {
      console.log(`WORLD A CONFIRMED — rank decided ${rankDecided}/${contended2.length} contended decisions`);
      console.log("once residency had lapsed and merits differed. The ranker IS wired and DOES");
      console.log("discriminate; it is simply never consulted during the mount storm, because residency");
      console.log("has already decided by then. M1's Row 3 is UPHELD and OQ9 is the real question.");
    } else {
      console.log("WORLD B — merits differed, residency had lapsed, and rank STILL decided nothing.");
      console.log("That is a wiring defect, not a preemption. M1's Row 3 is RETRACTED: the finding is");
      console.log("not 'residency preempts rank' but 'rank scoring does not reach the ordering'.");
      console.log("Do not proceed to OQ9 on this evidence — fix the wiring first.");
    }
    console.log("");
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
