/**
 * ADR-021 step 2 — ACCEPTANCE. Does the Flarex loader ceiling of 3 actually disappear?
 *
 * The step's win is a single, checkable claim: *"a 4th, 5th, 10th MediaIn stops being denied at
 * mount"* (DEBT-013 clause (a)). This probe demonstrates it rather than asserting it, on a real
 * running editor, and it is built to fail honestly in both directions.
 *
 * ── THE ARRANGEMENT ──────────────────────────────────────────────────────────────────────────────
 * ONE fixture, built ONCE, sampled after every MediaIn is added — so the ladder is a real ladder
 * (1,2,3,...,N loaders on one comp) rather than N separately-built comps that could differ in some
 * other way. Two arms over that same fixture, differing in exactly one variable:
 *
 *   `?flarexPullSeam=0`  loaders admitted by `preview-frame-pool` — the session cap. EXPECTED to stall
 *                        at 3 live decoders no matter how many nodes are bound. This arm is the
 *                        BEFORE picture, measured rather than quoted from a constant.
 *   `?flarexPullSeam=1`  loaders admitted by the byte budget (`flarex-source-providers.ts`).
 *
 * ── WHAT IS MEASURED, AND WHY EACH ONE ───────────────────────────────────────────────────────────
 * "Rendering" is not asserted from the node count. Three independent witnesses, because each alone
 * has a documented way of lying here:
 *
 *   1. `__rfSourceMap[flarexsrc:*]` — per loader: `decode` (wc-sw / wc-hw / element), `wcProvider`,
 *      `state`, `served`. A loader on `element` did NOT get a provider; a loader with `served: null`
 *      has a provider that never produced a frame. Both look like success in a node count.
 *   2. `__rfFlarexDegradation` — the compiler's own reasons. `host-substituted:*` on a MediaIn is
 *      precisely the user-visible defect: a node showing the HOST clip's picture because its loader
 *      has no decoder. A run with every node "live" but degradations climbing has not fixed anything.
 *   3. `__rfFlarexProviders` / `__rfWcPool` — the two admission authorities' own books. The pull arm
 *      must show the budget holding bytes and the POOL not being asked (no new capMisses from
 *      loaders); the pool arm must show capMisses, which is what makes its ceiling a measurement.
 *
 * ── HOW IT FAILS ─────────────────────────────────────────────────────────────────────────────────
 * VOID, not pass, when the arrangement did not happen: fewer nodes bound than asked for, the seam flag
 * not seen by the page, WebCodecs never engaged, or — the important one — **the pool arm failing to
 * show a ceiling**. If the BEFORE arm does not stall, this probe cannot claim the AFTER arm removed
 * anything, and it says so instead of printing a green tick over a fixture that never had the defect.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --dir apps/worker exec tsx src/flarex-loader-ceiling-probe.ts
 * Env: PROBE_SOURCES (default 12), PROBE_SETTLE_MS, PROBE_PROFILE, PROBE_BASE.
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
  reopenWithFlags,
} from "./browser/editor-session.js";
import { assertZeroBrowserFloor } from "./browser/browser-preflight.js";

const SOURCES = Math.max(2, Number(process.env.PROBE_SOURCES ?? 12));
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS ?? 9_000);
/** The pool's ceiling, from its own constants: MAX_WC_TOTAL_SESSIONS(4) − HARDWARE_RESERVED_SLOTS(1). */
const POOL_CEILING = 3;

/**
 * `PROBE_EXTRA_FLAGS` rides on BOTH arms, so anything set there stays a constant of the comparison and
 * cannot become a second variable. Used to settle `flarexSwDecode`: the software-decode rule was
 * written for a 3-loader comp contending over the GPU's single H.264 block, and 12 concurrent SOFTWARE
 * 1080p decoders is a different proposition entirely.
 */
const EXTRA_FLAGS = process.env.PROBE_EXTRA_FLAGS ? `&${process.env.PROBE_EXTRA_FLAGS}` : "";

const ARMS = [
  { key: "pool", name: "session-capped pool  (BEFORE)", flags: "flarexPullSeam=0", expectSeam: false },
  { key: "seam", name: "byte-budgeted seam   (AFTER)", flags: "flarexPullSeam=1", expectSeam: true },
] as const;

interface LoaderRow {
  id: string;
  asset: string;
  decode: string;
  wcProvider: boolean;
  state: string;
  served: number | null;
  /** `awaitReason` — WHICH branch produced "no frame". The field built for exactly this question. */
  why: string | null;
  wcBusy: boolean;
  staleMs: number | null;
}

interface Sample {
  allSourceMapKeys: string[];
  singleCtx: boolean;
  loaders: LoaderRow[];
  /** Loaders holding a real WebCodecs provider AND having served at least one frame. */
  rendering: number;
  onElement: number;
  budget: { budgetBytes: number; heldBytes: number; live: number; providers: number; evictions: number; rebuilds: number; denials: number; peakHeldBytes: number; pulls: number; framesServed: number; nulls: number; wedges: number; awaitingBuild: number; awaitingDecode: number; buildFailures: number } | null;
  pool: { created: number; capMisses: number; admissionDenials: number } | null;
  hostSubstitutions: number;
  seamFlag: boolean | null;
  heals: Record<string, number>;
}

async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const w = globalThis as unknown as Record<string, any>;
    const map = (w.__rfSourceMap ?? {}) as Record<string, any>;
    const loaders = Object.entries(map)
      .filter(([id]) => id.startsWith("flarexsrc:"))
      .map(([id, s]) => ({
        id,
        asset: String(s.asset ?? "-"),
        decode: String(s.decode ?? "-"),
        wcProvider: Boolean(s.wcProvider),
        state: String(s.state ?? "-"),
        served: s.served == null ? null : Number(s.served),
        why: s.why == null ? null : String(s.why),
        wcBusy: Boolean(s.wcBusy),
        staleMs: s.staleMs == null ? null : Number(s.staleMs),
      }));
    const budget = w.__rfFlarexProviders
      ? {
          budgetBytes: Number(w.__rfFlarexProviders.budgetBytes ?? 0),
          heldBytes: Number(w.__rfFlarexProviders.heldBytes ?? 0),
          live: Number(w.__rfFlarexProviders.live ?? 0),
          providers: Number(w.__rfFlarexProviders.providers ?? 0),
          evictions: Number(w.__rfFlarexProviders.evictions ?? 0),
          rebuilds: Number(w.__rfFlarexProviders.rebuilds ?? 0),
          denials: Number(w.__rfFlarexProviders.denials ?? 0),
          peakHeldBytes: Number(w.__rfFlarexProviders.peakHeldBytes ?? 0),
          pulls: Number(w.__rfFlarexProviders.pulls ?? 0),
          framesServed: Number(w.__rfFlarexProviders.framesServed ?? 0),
          nulls: Number(w.__rfFlarexProviders.nulls ?? 0),
          wedges: Number(w.__rfFlarexProviders.wedges ?? 0),
          awaitingBuild: Number(w.__rfFlarexProviders.awaitingBuild ?? 0),
          awaitingDecode: Number(w.__rfFlarexProviders.awaitingDecode ?? 0),
          buildFailures: Number(w.__rfFlarexProviders.buildFailures ?? 0),
        }
      : null;
    const pool = w.__rfWcPool
      ? {
          created: Number(w.__rfWcPool.created ?? 0),
          capMisses: Number(w.__rfWcPool.capMisses ?? 0),
          admissionDenials: Number(w.__rfWcPool.admissionDenials ?? 0),
        }
      : null;
    // The compiler's own census of "this MediaIn showed the HOST clip instead" — the user-visible
    // defect itself, not a proxy for it. `substitutedTotal` is the number ADR-012 S4.5 is judged
    // against and is already summed across nodes by `summarizeFlarexDegradations`.
    const hostSubstitutions = Number(w.__rfFlarexDegradation?.substitutedTotal ?? 0);
    return {
      // Every key the source map holds, loader or not. Present because the first run reported "loaders
      // present: 0" while the budget reported 8 live providers — two instruments disagreeing about
      // whether anything mounted at all, which no filtered count can explain.
      allSourceMapKeys: Object.keys(map),
      singleCtx: Boolean(w.__rfSingleCtx ?? w.__rfSingleCtxPreview),
      // WHICH self-heal sent a loader to <video>. `initTimeout` vs `nullFrames` vs `noSource` are three
      // different causes with three different fixes, and the element column alone cannot separate them.
      heals: { ...(w.__rfWcHeals ?? {}) } as Record<string, number>,
      loaders,
      rendering: loaders.filter((l) => l.wcProvider && l.decode !== "element" && l.served != null).length,
      onElement: loaders.filter((l) => l.decode === "element").length,
      budget,
      pool,
      hostSubstitutions,
      seamFlag: typeof w.__rfFlarexPullSeam === "boolean" ? w.__rfFlarexPullSeam : null,
    };
  });
}

/**
 * WIRE every asset-source MediaIn into ONE picture, through a Merge chain, and make MediaOut read it.
 *
 * NOT cosmetic, and not a shortcut around the UI — it is the difference between a fixture that tests
 * the claim and one that cannot. `addAssetSourceMediaIn` deliberately does not wire (dragging edges in
 * Playwright is flake for no measurement), and for the questions it was written for that is right: an
 * UNWIRED MediaIn still mounts a loader and still opens a decoder, which is all a decoder census needs.
 *
 * It is not enough here. Reachability is computed by walking back from the comp's active roots, so an
 * unwired MediaIn is never evaluated, `resolveSourceDraw` is never called for it, and it therefore
 * produces no picture and no `__rfSourceMap` row **even when its decoder is running perfectly**. The
 * first run of this probe measured exactly that: 6 loaders bound, 6 entries in `__rfWcMode`, 4 live
 * providers — and ZERO loaders in the source map, because none of them fed anything. A ceiling probe
 * built on that fixture reports 0 rendering in both arms and cannot tell a fix from a regression.
 * Unwired loaders are additionally demoted while playing (they feed nothing the viewer shows), so the
 * fixture suppresses the very concurrency it is trying to create.
 *
 * The graph is written into the project's own localStorage record — the same shape the editor persists
 * — rather than synthesized in memory, so the reload path, the healer and the compiler all see an
 * ordinary comp. Chain shape: `in0 → merge0.bg`, `in1 → merge0.fg`, `merge0 → merge1.bg`, `in2 →
 * merge1.fg`, …, last merge → `mediaOut.in`. Every source is a foreground on its own merge, so all N
 * are simultaneously reachable from MediaOut and all N must decode for the frame to be correct.
 */
async function wireMediaInsIntoOnePicture(page: Page): Promise<{ ok: boolean; detail: string }> {
  const result = await page.evaluate(() => {
    const KEY = "orreris_local_projects";
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ok: false, detail: "no local projects in storage" };
    const projects = JSON.parse(raw) as any[];
    const project = projects[projects.length - 1];
    const comps = project?.projectGraph?.flarexComps ?? project?.graph?.flarexComps;
    if (!comps) return { ok: false, detail: "project has no flarexComps" };
    const comp = Object.values(comps)[0] as any;
    if (!comp) return { ok: false, detail: "no comp on the project" };

    const nodes = Object.values(comp.nodes) as any[];
    // Only ASSET-bound MediaIns: a host-clip MediaIn (empty sourceAssetId) has no loader by design and
    // would contribute a node to the chain that can never be evidence about a decoder budget.
    const sources = nodes.filter((n) => n.type === "mediaIn" && typeof n.params?.sourceAssetId === "string" && n.params.sourceAssetId);
    const out = nodes.find((n) => n.type === "mediaOut");
    if (!out) return { ok: false, detail: "comp has no mediaOut" };
    if (sources.length < 2) return { ok: false, detail: `only ${sources.length} asset-bound MediaIn(s)` };

    const edges: any[] = [];
    const merges: any[] = [];
    let upstream = sources[0]!.id;
    for (let i = 1; i < sources.length; i += 1) {
      const id = `probe_merge_${i}`;
      merges.push({
        id,
        type: "merge",
        enabled: true,
        params: { blend: "normal", opacity: 1 },
        ui: { x: 240 + i * 200, y: 120 },
      });
      edges.push({ id: `probe_e_bg_${i}`, from: { nodeId: upstream, socket: "out" }, to: { nodeId: id, socket: "bg" } });
      edges.push({ id: `probe_e_fg_${i}`, from: { nodeId: sources[i]!.id, socket: "out" }, to: { nodeId: id, socket: "fg" } });
      upstream = id;
    }
    edges.push({ id: "probe_e_out", from: { nodeId: upstream, socket: "out" }, to: { nodeId: out.id, socket: "in" } });

    for (const m of merges) comp.nodes[m.id] = m;
    comp.edges = edges;
    // The view dot must not re-root the compile at one node — that would make every OTHER source
    // unreachable again, which is the defect this function exists to remove.
    comp.previewNodeId = undefined;
    comp.version = Number(comp.version ?? 0) + 1;
    window.localStorage.setItem(KEY, JSON.stringify(projects));
    return { ok: true, detail: `${sources.length} sources → ${merges.length} merges → mediaOut` };
  });
  return result;
}

/** Distinct seed files — see `importAssets`: N copies of one asset is ONE decoder behind N doors, and
 *  a fixture built that way can never exceed any budget it claims to test. */
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
  if (picked.length < count) throw new Error(`need ${count} distinct clips, found ${picked.length} in ${dir}`);
  return picked;
}

async function playAndSettle(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  const play = page.locator('button[title*="Play"], button[aria-label*="Play"]').first();
  await play.click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

async function main(): Promise<void> {
  assertZeroBrowserFloor("flarex-loader-ceiling");
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  console.log("PRECONDITIONS");
  console.log(`  PIXEL_BROWSER_CHANNEL : ${channel ?? "(unset — SwiftShader risk, see the probe-regime rule)"}`);
  console.log(`  extra flags (both arms): ${process.env.PROBE_EXTRA_FLAGS ?? "(none)"}`);

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
  const projectUrl = await reachEditor(page, { clipPath: clips[0]!, flags: "wcDecode=1&flarexTrace=1" });
  console.log(`  project               : ${projectUrl}`);

  // BUILD IDENTITY for the file the measurement depends on, not a neighbouring one. `__rfFlarexPullSeam`
  // is published unconditionally by this build and by no previous one.
  const seamSymbol = await page.evaluate(() => typeof (globalThis as any).__rfFlarexPullSeam);
  console.log(`  build identity        : __rfFlarexPullSeam is "${seamSymbol}" ${seamSymbol === "boolean" ? "— this build" : "— ABSENT, the bundle predates the seam"}`);
  if (seamSymbol !== "boolean") {
    console.log("\n[ceiling] ⚠ VOID — the running bundle has no pull seam. Nothing below would be about it.");
    process.exitCode = 1;
  }

  if (!(await awaitWebCodecsEngaged(page))) {
    console.log("  subsystem liveness    : ⚠ WebCodecs never engaged — the decoder path under test is not running.");
    process.exitCode = 1;
  } else {
    console.log("  subsystem liveness    : WebCodecs engaged");
  }

  const tiles = await importAssets(page, clips.slice(1));
  console.log(`  asset bin             : ${tiles} tile(s)\n`);

  console.log(`Building ONE comp with ${SOURCES} asset-source MediaIns…`);
  const first = await addAssetSourceMediaIn(page);
  let bound = first.ok ? 1 : 0;
  if (!first.ok) console.log(`  · MediaIn 1 FAILED at gate \`${first.gate}\``);
  for (let i = 1; i < SOURCES; i += 1) {
    const result = await addMediaInBoundTo(page, i);
    if (result.ok) bound += 1;
    else console.log(`  · MediaIn ${i + 1} FAILED at gate \`${result.gate}\` ${result.detail ?? ""}`);
  }
  console.log(`  sources bound         : ${bound}/${SOURCES}`);

  const wired = await wireMediaInsIntoOnePicture(page);
  console.log(`  graph wired           : ${wired.ok ? wired.detail : `FAILED — ${wired.detail}`}`);
  if (!wired.ok) {
    console.log("\n[ceiling] ⚠ VOID — the sources were never wired into one picture, so none of them is reachable\n          from MediaOut and none would render in either arm. Nothing below is about a ceiling.");
    process.exitCode = 1;
  }
  console.log("");

  const armResults: { arm: (typeof ARMS)[number]; s: Sample }[] = [];
  for (const arm of ARMS) {
    console.log(`── ${arm.name}   [?${arm.flags}]`);
    await reopenWithFlags(page, projectUrl, `${arm.flags}&wcDecode=1&flarexTrace=1${EXTRA_FLAGS}`);
    await playAndSettle(page);
    const s = await sample(page);
    armResults.push({ arm, s });
    console.log(`   seam flag seen by page : ${s.seamFlag === null ? "ABSENT" : s.seamFlag}`);
    console.log(`   loaders present        : ${s.loaders.length}  (source-map keys total ${s.allSourceMapKeys.length})`);
    if (!s.loaders.length && s.allSourceMapKeys.length) {
      console.log(`      source-map keys: ${s.allSourceMapKeys.slice(0, 8).map((k) => (k.length > 40 ? `…${k.slice(-40)}` : k)).join(" | ")}`);
    }
    console.log(`   RENDERING (provider + served frame) : ${s.rendering}`);
    console.log(`   fell back to <video>   : ${s.onElement}`);
    console.log(`   host substitutions     : ${s.hostSubstitutions}`);
    console.log(`   wc self-heals          : ${Object.entries(s.heals).map(([k, v]) => `${k}=${v}`).join(" · ") || "none"}`);
    if (s.pool) console.log(`   pool                   : created ${s.pool.created} · capMisses ${s.pool.capMisses} · denials ${s.pool.admissionDenials}`);
    if (s.budget) {
      console.log(
        `   byte budget            : held ${(s.budget.heldBytes / 1048576).toFixed(0)}MB / ${(s.budget.budgetBytes / 1048576).toFixed(0)}MB ` +
          `(peak ${(s.budget.peakHeldBytes / 1048576).toFixed(0)}MB) · live ${s.budget.live} · evict ${s.budget.evictions} · rebuild ${s.budget.rebuilds} · denials ${s.budget.denials}
` +
          `   seam liveness          : pulls ${s.budget.pulls} · frames served ${s.budget.framesServed} · nulls ${s.budget.nulls} · wedges ${s.budget.wedges} · IN FLIGHT: awaiting-build ${s.budget.awaitingBuild} awaiting-decode ${s.budget.awaitingDecode} · build-failures ${s.budget.buildFailures}`
      );
    } else {
      console.log("   byte budget            : (not engaged — expected in the pool arm)");
    }
    for (const l of s.loaders) {
      console.log(
        `      ${l.id.split(":").slice(-1)[0]!.padEnd(14)} ${l.decode.padEnd(8)} provider=${String(l.wcProvider).padEnd(5)} ` +
          `${l.state.padEnd(9)} served=${(l.served == null ? "—" : l.served.toFixed(2)).padEnd(7)} why=${(l.why ?? "—").padEnd(22)} busy=${String(l.wcBusy).padEnd(5)} stale=${l.staleMs ?? "—"}`
      );
    }
    console.log("");
  }

  // ── VERDICT ────────────────────────────────────────────────────────────────
  const pool = armResults.find((r) => r.arm.key === "pool")!;
  const seam = armResults.find((r) => r.arm.key === "seam")!;
  console.log("════ ADR-021 step 2 — the loader ceiling ════");
  console.log(`  bound MediaIns                : ${bound}`);
  console.log(`  rendering, pool arm  (BEFORE) : ${pool.s.rendering}`);
  console.log(`  rendering, seam arm  (AFTER)  : ${seam.s.rendering}`);

  const flagsSeen = pool.s.seamFlag === false && seam.s.seamFlag === true;
  if (!flagsSeen) {
    console.log(
      `\n[ceiling] ⚠ VOID — an arm's page did not see the flag it was supposed to run under ` +
        `(${pool.s.seamFlag} · ${seam.s.seamFlag}). Two arms that agree mean nothing until the switch is known to have landed.`
    );
    process.exitCode = 1;
  } else if (bound <= POOL_CEILING) {
    console.log(
      `\n[ceiling] ⚠ VOID — only ${bound} sources were bound, which fits the pool's ${POOL_CEILING}-loader ceiling.\n` +
        "          A fixture that never exceeds the ceiling cannot show one being removed."
    );
    process.exitCode = 1;
  } else if (pool.s.rendering > POOL_CEILING) {
    // The BEFORE arm must actually exhibit the defect. Without this the AFTER arm's number is a
    // description of a fixture, not evidence about a ceiling.
    console.log(
      `\n[ceiling] ⚠ VOID — the pool arm rendered ${pool.s.rendering} loaders, above its own ${POOL_CEILING}-slot ceiling.\n` +
        "          The BEFORE picture does not show the defect, so nothing here is evidence that it was removed."
    );
    process.exitCode = 1;
  } else if (seam.s.rendering <= pool.s.rendering) {
    console.log(
      `\n[ceiling] ✗ FAIL — the seam arm rendered ${seam.s.rendering} loaders against the pool arm's ${pool.s.rendering}.\n` +
        "          The ceiling did not move. That is the step's whole claim."
    );
    process.exitCode = 1;
  } else {
    const denied = seam.s.budget?.denials ?? 0;
    const evicted = seam.s.budget?.evictions ?? 0;
    console.log(
      `\n[ceiling] ✓ THE CEILING MOVED — ${pool.s.rendering} → ${seam.s.rendering} concurrently rendering loaders.\n` +
        `          Byte budget: ${((seam.s.budget?.peakHeldBytes ?? 0) / 1048576).toFixed(0)}MB peak of ` +
        `${((seam.s.budget?.budgetBytes ?? 0) / 1048576).toFixed(0)}MB, ${evicted} eviction(s), ${denied} denial(s).`
    );
    // Where it stops, and WHY, is the honest half of the report — an eviction is correct behaviour, a
    // denial at mount is the thing being fixed.
    if (seam.s.rendering < bound) {
      console.log(
        `          NOT ALL ${bound} are rendering (${seam.s.rendering}). Reason, from the books rather than assumed:\n` +
          `            budget denials ${denied} · evictions ${evicted} · fell back to <video> ${seam.s.onElement} · ` +
          `host substitutions ${seam.s.hostSubstitutions}\n` +
          "          A non-zero eviction count with zero denials is the budget working as designed."
      );
    }
  }

  const closed = (async () => {
    await context.close();
    await browser?.close();
  })();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 15_000))]).catch(() => undefined);
}

main()
  .then(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 3_000).unref();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
