/**
 * ADR-021 step 3a closeout — re-measure the 92-95% edit-reuse figure on a REAL graph with REAL
 * footage, instead of on the synthetic 121-node round that produced §3.2(c).
 *
 * ── TWO PHASES, AND WHAT EACH ONE IS EVIDENCE FOR ────────────────────────────────────────────────
 *
 * PHASE 1 (browser). Builds a real comp in a real editor: real project renders imported through the
 * product's own asset path, bound as asset-source `MediaIn`s through the product's own "add MediaIn"
 * flow, then grown into a graph of the shape §3.2(c) measured (~120 nodes over 12 sources) by writing
 * the comp into the project's own localStorage record — the same persistence the editor writes, so the
 * healer and the compiler see an ordinary comp. It then PAUSES, settles, and reads `__rfIncremental`.
 *
 * That read is the liveness proof and nothing more: it says the shipped mechanism is running in the
 * product and is registering real reuse on a still frame. Per the measurement-preconditions rule, a
 * per-edit figure computed against a mechanism that was never shown to run is a void number.
 *
 * PHASE 2 (pure). Drives the REAL `dependency-graph.ts` closure — `declareNode` / `markDirty` /
 * `markAxisDirty` / `dirtyClosure`, through the REAL `beginIncrementalFrame` — over the comp captured
 * in phase 1, once per edit class, and reports the fraction of nodes that survive as reusable.
 *
 * WHY THE EDITS ARE NOT DRIVEN AS UI GESTURES. A param drag could be, but a REWIRE could not:
 * `flarex-loader-ceiling-probe.ts` records that dragging edges in Playwright "is flake for no
 * measurement", which is why it writes its own wiring the same way. Driving one edit class by gesture
 * and two by mutation would make the three figures incomparable — a worse defect than driving all
 * three the same way and saying so. What phase 2 does NOT claim is that a human's gesture produces the
 * same comp; phase 1's capture is what makes the GRAPH real, and the edits are applied with the
 * editor's own helpers (`applyNodeParamValueAtTime`, `setNodeParamBase`) wherever one exists.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker flarex:reuse-measure
 * Env: PROBE_SOURCES (default 12), PROBE_BASE, REUSE_COMP (skip phase 1, read a captured comp).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { addAssetSourceMediaIn, addMediaInBoundTo, awaitWebCodecsEngaged, defaultClipPath, importAssets, reachEditor } from "./browser/editor-session.js";
import { assertZeroBrowserFloor } from "./browser/browser-preflight.js";
import { createFlarexNode, type FlarexComp } from "@orreris/shared";
import { beginIncrementalFrame, commitIncrementalFrame, resetIncrementalEvaluation } from "../../web/src/playback/incremental-evaluation.js";
import { applyNodeParamValueAtTime, setNodeParamBase } from "../../web/src/editor/flarex/flarex-keyframes.js";

const SOURCES = Math.max(2, Number(process.env.PROBE_SOURCES ?? 12));
const OUT_DIR = path.resolve(process.cwd(), "tmp/adr021-reuse");
const COMP_PATH = path.join(OUT_DIR, "captured-comp.json");

function seedClips(count: number): string[] {
  const first = defaultClipPath();
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

/**
 * Grow the bound sources into a graph of the shape §3.2(c) measured: every source gets its own
 * colorCorrect → transform → blur chain, then all are merged into one picture. ~120 nodes over 12
 * sources, against the ADR's 121 nodes over 24. Written through the project's own localStorage record.
 */
async function growGraph(page: Page): Promise<{ ok: boolean; detail: string }> {
  return page.evaluate(() => {
    const KEY = "orreris_local_projects";
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ok: false, detail: "no local projects" };
    const projects = JSON.parse(raw) as any[];
    const project = projects[projects.length - 1];
    const comps = project?.projectGraph?.flarexComps ?? project?.graph?.flarexComps;
    if (!comps) return { ok: false, detail: "no flarexComps" };
    const comp = Object.values(comps)[0] as any;
    const nodes = Object.values(comp.nodes) as any[];
    const sources = nodes.filter((n) => n.type === "mediaIn" && typeof n.params?.sourceAssetId === "string" && n.params.sourceAssetId);
    const out = nodes.find((n) => n.type === "mediaOut");
    if (!out) return { ok: false, detail: "no mediaOut" };
    if (sources.length < 2) return { ok: false, detail: `only ${sources.length} asset MediaIn(s)` };

    // NO FUNCTION-VALUED CONSTS IN HERE. tsx compiles with `keepNames`, which wraps a
    // `const f = () => {}` in `__name(...)` — a helper that exists in the bundle and NOT in the page,
    // so every arm dies with "__name is not defined". Cost one run here before the rule was recalled.
    // Everything below is therefore written out inline.
    const edges: any[] = [];
    const tails: string[] = [];
    for (let i = 0; i < sources.length; i += 1) {
      const src = sources[i]!;
      const cc = `m_cc_${i}`;
      const tr = `m_tr_${i}`;
      const bl = `m_bl_${i}`;
      comp.nodes[cc] = { id: cc, type: "colorCorrect", enabled: true, params: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, saturation: 100, vibrance: 0, temperature: 0, tint: 0 }, ui: { x: 0, y: 0 } };
      comp.nodes[tr] = { id: tr, type: "transform", enabled: true, params: { x: 0, y: 0, scale: 1, rotation: 0 }, ui: { x: 0, y: 0 } };
      comp.nodes[bl] = { id: bl, type: "blur", enabled: true, params: { amount: 2 }, ui: { x: 0, y: 0 } };
      edges.push({ id: `m_e_cc_${i}`, from: { nodeId: src.id, socket: "out" }, to: { nodeId: cc, socket: "in" } });
      edges.push({ id: `m_e_tr_${i}`, from: { nodeId: cc, socket: "out" }, to: { nodeId: tr, socket: "in" } });
      edges.push({ id: `m_e_bl_${i}`, from: { nodeId: tr, socket: "out" }, to: { nodeId: bl, socket: "in" } });
      tails.push(bl);
    }
    let upstream = tails[0]!;
    for (let i = 1; i < tails.length; i += 1) {
      const id = `m_merge_${i}`;
      comp.nodes[id] = { id, type: "merge", enabled: true, params: { blend: "normal", opacity: 1 }, ui: { x: 0, y: 0 } };
      edges.push({ id: `m_e_bg_${i}`, from: { nodeId: upstream, socket: "out" }, to: { nodeId: id, socket: "bg" } });
      edges.push({ id: `m_e_fg_${i}`, from: { nodeId: tails[i]!, socket: "out" }, to: { nodeId: id, socket: "fg" } });
      upstream = id;
    }
    edges.push({ id: "m_e_out", from: { nodeId: upstream, socket: "out" }, to: { nodeId: out.id, socket: "in" } });
    comp.edges = edges;
    comp.previewNodeId = undefined;
    comp.version = Number(comp.version ?? 0) + 1;
    window.localStorage.setItem(KEY, JSON.stringify(projects));
    return { ok: true, detail: `${Object.keys(comp.nodes).length} nodes over ${sources.length} sources` };
  });
}

async function captureComp(page: Page): Promise<FlarexComp | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("orreris_local_projects");
    if (!raw) return null;
    const projects = JSON.parse(raw) as any[];
    const project = projects[projects.length - 1];
    const comps = project?.projectGraph?.flarexComps ?? project?.graph?.flarexComps;
    return comps ? (Object.values(comps)[0] as any) : null;
  }) as Promise<FlarexComp | null>;
}

// ── PHASE 2 ──────────────────────────────────────────────────────────────────────────────────────

const CONTEXT = { renderScale: 1, width: 1920, height: 1080, gradeCompareKey: "" };
const T = 1.0;

/**
 * Reusable fraction over EVERY node of `comp` at a still playhead, after `mutate` is applied.
 *
 * The first frame records every node; the second asks the real reuse channel about each one. The
 * playhead does not move between them, which is the case the figure is about — §3.2(c) already
 * establishes that a moving playhead dirties ~100% by design, and mixing that in would measure the
 * time axis rather than the edit.
 */
function reusableFraction(
  comp: FlarexComp,
  mediaEpoch: number,
  mutate: (c: FlarexComp) => FlarexComp,
  /**
   * The epoch on the SECOND frame. Defaults to the first frame's, i.e. "no new picture decoded".
   *
   * Split into two parameters because passing one value for both frames is what made the first run's
   * "source change" row read 100% REUSABLE — an epoch that never moves between the two frames is not a
   * source change at all, so the row measured nothing and reported it as a perfect hit rate. A
   * wrong-direction number that flatters the subject is the failure mode this repo's register keeps
   * recording; it was caught because the row disagreed with §3.2(c) in the direction that should have
   * been impossible.
   */
  mediaEpochAfter = mediaEpoch
): { reusable: number; total: number; pct: number } {
  resetIncrementalEvaluation();
  const ids = Object.keys(comp.nodes);
  const ctxKey = (id: string) => `${id}@${T.toFixed(6)}`;
  const MATTE = { kind: "matte", matte: { kind: "vector", masks: [] } };

  const first = beginIncrementalFrame({ comps: { [comp.id]: comp }, ...CONTEXT, mediaEpoch, frameTimeSeconds: T, frameId: 1, nowMs: 16 });
  if (!first) throw new Error("no channels");
  for (const id of ids) first.onEvaluated(comp.id, id, ctxKey(id), MATTE);
  commitIncrementalFrame();

  const next = mutate(comp);
  const second = beginIncrementalFrame({ comps: { [next.id]: next }, ...CONTEXT, mediaEpoch: mediaEpochAfter, frameTimeSeconds: T, frameId: 2, nowMs: 32 });
  if (!second) throw new Error("no channels");
  let reusable = 0;
  for (const id of Object.keys(next.nodes)) if (second.reuseValue(next.id, id, ctxKey(id)) !== null) reusable += 1;
  commitIncrementalFrame();
  const total = Object.keys(next.nodes).length;
  return { reusable, total, pct: total ? (reusable / total) * 100 : 0 };
}

function firstOfType(comp: FlarexComp, type: string): string | null {
  for (const [id, node] of Object.entries(comp.nodes)) if ((node as { type: string }).type === type) return id;
  return null;
}

function phase2(comp: FlarexComp): void {
  const nodeCount = Object.keys(comp.nodes).length;
  const sourceCount = Object.values(comp.nodes).filter((n) => (n as { type: string }).type === "mediaIn").length;
  console.log(`\nPHASE 2 — real closure over the captured graph: ${nodeCount} nodes, ${sourceCount} mediaIn\n`);

  const cc = firstOfType(comp, "colorCorrect");
  const blur = firstOfType(comp, "blur");
  // The LAST source's chain as well as the first. A merge CHAIN makes the closure fraction a function
  // of WHERE the edit lands — an edit at the head flows through every merge below it, one at the tail
  // through almost none — so a single figure for "param drag" would be an artifact of which node the
  // harness happened to pick. Reporting both is what makes the spread visible instead of averaged away.
  const ccIds = Object.keys(comp.nodes).filter((id) => (comp.nodes[id] as { type: string }).type === "colorCorrect");
  const ccTail = ccIds.length ? ccIds[ccIds.length - 1]! : null;
  if (!cc || !blur) {
    console.log("  ⚠ VOID — the captured graph has no colorCorrect/blur node to edit.");
    process.exitCode = 1;
    return;
  }

  const rows: { label: string; reusable: number; total: number; pct: number; note: string }[] = [];

  // Counterweight: nothing changed. Anything below 100% here means the harness itself invalidates,
  // and every other row would be measuring that instead of the edit.
  rows.push({ ...reusableFraction(comp, 1, (c) => c), label: "NO EDIT (counterweight)", note: "must be 100%" });

  // (a) param drag — the editor's own write path on a NON-animated param, at BOTH ends of the chain.
  rows.push({ ...reusableFraction(comp, 1, (c) => setNodeParamBase(c, cc, "exposure", 25)), label: "param drag @ HEAD source", note: "§3.2(c) said 7.4% dirty → 92.6% reusable" });
  if (ccTail && ccTail !== cc) {
    rows.push({ ...reusableFraction(comp, 1, (c) => setNodeParamBase(c, ccTail, "exposure", 25)), label: "param drag @ TAIL source", note: "same edit, other end of the merge chain" });
  }

  // (b) rewire — bypass one node's chain, which changes a downstream node's declared upstream set.
  rows.push({
    ...reusableFraction(comp, 1, (c) => {
      const edges = c.edges.map((e) => e);
      const idx = edges.findIndex((e) => e.to.nodeId === blur);
      if (idx >= 0) edges[idx] = { ...edges[idx]!, from: { nodeId: cc, socket: "out" } };
      return { ...c, edges };
    }),
    label: "rewire one edge",
    note: "§3.2(c) said 5.0% dirty → 95.0% reusable",
  });

  // (c) source change — a decoded frame arrives, so the epoch MOVES between the two frames.
  rows.push({ ...reusableFraction(comp, 1, (c) => c, 2), label: "source change (media epoch)", note: "§3.2(c) said 8.3% dirty → 91.7% reusable" });

  // (d) the class the invalidation gate found. Reported HERE because a reuse figure that counts a
  // failed invalidation as a hit is flattering itself, and this is the number that shows it.
  rows.push({
    ...reusableFraction(comp, 1, (c) => applyNodeParamValueAtTime({ ...c, animations: [...c.animations, { id: "kf_probe", target: { scope: "flarexNode", effectId: cc, property: "exposure" }, timeSeconds: 5, value: 50, interpolation: "linear", temporal: {} } as never] }, cc, "exposure", T, 42)),
    label: "slider drag on an ANIMATED param",
    note: "SHOULD invalidate; see flarex:incremental-gate",
  });

  for (const r of rows) {
    console.log(`  ${r.label.padEnd(34)} reusable ${String(r.reusable).padStart(4)}/${String(r.total).padEnd(4)} = ${r.pct.toFixed(1).padStart(5)}%   ${r.note}`);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (process.env.REUSE_COMP || fs.existsSync(COMP_PATH)) {
    const p = process.env.REUSE_COMP ?? COMP_PATH;
    if (!process.env.REUSE_COMP) console.log(`(re-using the captured graph at ${p}; delete it to re-capture)\n`);
    phase2(JSON.parse(fs.readFileSync(p, "utf8")) as FlarexComp);
    return;
  }

  assertZeroBrowserFloor("flarex-reuse-measure");
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  console.log("PHASE 1 — build a real comp on real footage");
  console.log(`  PIXEL_BROWSER_CHANNEL : ${channel ?? "(unset — SwiftShader risk)"}`);
  const browser = await chromium.launch(channel ? { channel } : {});
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());

  const clips = seedClips(SOURCES);
  const projectUrl = await reachEditor(page, { clipPath: clips[0]!, flags: "wcDecode=1&flarexTrace=1" });
  console.log(`  project               : ${projectUrl}`);
  const tiles = await importAssets(page, clips.slice(1));
  console.log(`  asset bin             : ${tiles} tile(s)`);

  // Same settle the ceiling probe takes before touching the Flarex page. Dropping it once already cost
  // a run: `addAssetSourceMediaIn` reported 0/12 with no reason printed, because this probe swallowed
  // the `gate` field the helper exists to return. Both are fixed here — wait, and print the gate.
  if (!(await awaitWebCodecsEngaged(page))) console.log("  subsystem liveness    : ⚠ WebCodecs never engaged");
  else console.log("  subsystem liveness    : WebCodecs engaged");

  const first = await addAssetSourceMediaIn(page);
  let bound = first.ok ? 1 : 0;
  if (!first.ok) console.log(`  · MediaIn 1 FAILED at gate \`${first.gate}\` ${first.detail ?? ""}`);
  for (let i = 1; i < SOURCES; i += 1) {
    const r = await addMediaInBoundTo(page, i);
    if (r.ok) bound += 1;
    else console.log(`  · MediaIn ${i + 1} FAILED at gate \`${r.gate}\` ${r.detail ?? ""}`);
  }
  console.log(`  sources bound         : ${bound}/${SOURCES}`);
  if (!bound) {
    console.log("\n⚠ VOID — no asset-source MediaIn was bound, so there is no real graph to measure.");
    process.exitCode = 1;
    await context.close();
    await browser.close();
    return;
  }

  const grown = await growGraph(page);
  console.log(`  graph grown           : ${grown.ok ? grown.detail : `FAILED — ${grown.detail}`}`);
  if (!grown.ok) {
    process.exitCode = 1;
    await context.close();
    await browser.close();
    return;
  }

  await page.goto(projectUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(12_000);

  /**
   * LIVENESS AND STEADY STATE — as a DELTA, not as a cumulative total.
   *
   * The first run of this probe read the cumulative counters and reported `reused=0` over 380 frames.
   * That total spans the MOUNT STORM, in which twelve sources are decoding and every arriving picture
   * moves `mediaEpoch` — which marks the `source` axis dirty, which dirties every `mediaIn` and, through
   * the merge chain, the whole graph. A cumulative counter therefore cannot tell "this mechanism never
   * reuses" from "this mechanism cannot reuse while the comp is still settling", and those have
   * opposite meanings for step 3a. Sampled twice, after a long settle, so the window contains steady
   * state only.
   */
  const sampleStats = async () => page.evaluate(() => ({ ...((globalThis as any).__rfIncremental ?? {}) })) as Promise<Record<string, number>>;
  const cumulative = await sampleStats();
  console.log(`  __rfIncremental (cum) : ${Object.entries(cumulative).map(([k, v]) => `${k}=${String(v)}`).join(" · ") || "ABSENT"}`);
  await page.waitForTimeout(20_000); // let the mount storm finish and decoding go quiet
  const a = await sampleStats();
  await page.waitForTimeout(8_000);
  const b = await sampleStats();
  const dReused = (b["reused"] ?? 0) - (a["reused"] ?? 0);
  const dEval = (b["evaluated"] ?? 0) - (a["evaluated"] ?? 0);
  const dFrames = (b["frames"] ?? 0) - (a["frames"] ?? 0);
  console.log(`  steady-state delta    : frames=${dFrames} reused=${dReused} evaluated=${dEval}` + (dReused + dEval > 0 ? `  → ${((dReused / (dReused + dEval)) * 100).toFixed(1)}% reuse` : ""));
  console.log(`  dirty on last frame   : ${b["dirtyNodes"] ?? "?"}/${b["declaredNodes"] ?? "?"} nodes`);
  if (!(b["frames"] ?? 0)) {
    console.log("  ⚠ VOID — the incremental evaluator never ran a frame; nothing below would be about it.");
    process.exitCode = 1;
  }

  const comp = await captureComp(page);
  if (comp) {
    fs.writeFileSync(COMP_PATH, JSON.stringify(comp, null, 2));
    console.log(`  captured              : ${COMP_PATH}`);
  }
  await context.close();
  await browser.close();
  if (comp) phase2(comp);
}

main().then(
  () => setTimeout(() => process.exit(process.exitCode ?? 0), 1_000).unref(),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
