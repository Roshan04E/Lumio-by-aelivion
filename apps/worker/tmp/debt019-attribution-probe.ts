/**
 * DEBT-019 — WHAT holds the ~15 MB/source residual? (ADR-021 step 2, phase 1.)
 *
 * The entry's own park names the instrument this needs, and names it precisely because the last two
 * rounds used the wrong one:
 *
 *   > A heap snapshot with retainer paths taken at a large-N rung, plus a per-term ablation (build the
 *   > provider with the index disabled, with the chunk window disabled, with the decoder unconfigured,
 *   > and difference the retained sizes). The snapshot names the holder; the ablation prices it.
 *   > Either alone reproduces the error already made twice.
 *
 * So this probe runs BOTH, and does NOT open with a working-set delta used to answer "what".
 *
 *   PART A — per-term ablation. Six construction stages (see debt019-attribution-browser.js), each on
 *            a 3s and a 120s corpus, working-set delta per stage. Differencing adjacent stages prices
 *            each term; differencing corpora at one stage says whether that term scales with duration.
 *            The working set is used here ONLY for "how much", which is the one question it can answer,
 *            and only after the ablation has decided WHICH term is being priced.
 *   PART B — heap snapshot with retainer paths, both corpora, at the full-provider rung. Self size
 *            aggregated by object class, corpora differenced, and retainer paths walked for the classes
 *            that actually differ. This is what says whether the residual is on the JS heap AT ALL --
 *            a question no ladder in this entry has ever asked.
 *
 * Preconditions reported rather than assumed (measurement-preconditions rule):
 *   - PIXEL_BROWSER_CHANNEL=chrome (SwiftShader is a different machine)
 *   - zero-browser floor before every rung (browser-preflight REFUSES; it does not kill and continue)
 *   - build identity: the dev server's root is this worktree AND the served webcodecs-decoder.ts is
 *     this build (proven by `wcAblationBuild` existing, which no previous build has)
 *   - subsystem liveness: providers demuxed streaming, 0 nulls, decode calls and hard resets counted
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome DEBT019_MEDIA_SHORT=<dir> DEBT019_MEDIA_LONG=<dir> \
 *     pnpm --dir apps/worker exec tsx tmp/debt019-attribution-probe.ts
 */
import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { assertServingThisWorktree, getFreePort, startVite, stopProcess, waitForServer } from "./pull-bootstrap.js";
import { assertZeroBrowserFloor, reapAutomationBrowsers } from "../src/browser/browser-preflight.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHORT_DIR = process.env.DEBT019_MEDIA_SHORT ?? "";
const LONG_DIR = process.env.DEBT019_MEDIA_LONG ?? "";
/** The ablation rung. One N, both corpora — the ladder's shape is already known; the terms are not. */
const N = Number(process.env.DEBT019_N ?? 100);
/** The snapshot rung. Smaller, because a .heapsnapshot is JSON and must be parsed in this process. */
const SNAP_N = Number(process.env.DEBT019_SNAP_N ?? 25);
const VARIANTS = (process.env.DEBT019_VARIANTS ?? "ab-bytes,ab-index,ab-window,ab-configure,pull1,pull4").split(",");
const PULL_FRACTIONS = (process.env.DEBT019_PULL ?? "0.02,0.35,0.7,0.98").split(",").map(Number);
const OUT_DIR = process.env.DEBT019_OUT ?? path.join(here, "debt019-attribution");

interface Row {
  corpus: string;
  variant: string;
  baseMB: number;
  heldMB: number;
  deltaMB: number;
  perSrcMB: number;
  jsHeapMB: number;
  note: string;
}

function chromeMemoryMB(): number {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', { encoding: "utf8" });
    let kb = 0;
    for (const line of out.split(/\r?\n/)) {
      const m = /"([\d.,\s]+) K"\s*$/.exec(line.trim());
      if (m) kb += Number(m[1]!.replace(/[.,\s]/g, ""));
    }
    return kb / 1024;
  } catch {
    return Number.NaN;
  }
}

function processCount(image: string): number {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`, { encoding: "utf8" });
    return out.split(/\r?\n/).filter((l) => l.includes(image)).length;
  } catch {
    return -1;
  }
}

const LAUNCH_ARGS = [
  "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
];

/** Range-honoring media server, cross-origin from the probe page (a real remote source's shape). */
function startMediaServer(port: number, root: string): Promise<Server> {
  const base = path.resolve(root);
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\//, "");
    const file = path.resolve(base, name);
    if (!file.startsWith(base)) return void res.writeHead(403).end();
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return void res.writeHead(404).end();
    }
    const head: Record<string, string> = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
    const m = req.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
      res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, "Content-Length": String(size) });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// ── Part B: heap snapshot ─────────────────────────────────────────────────────

/**
 * Force a full GC and let the renderer settle before the working set is sampled.
 *
 * NOT optional, and the first run without it is why: the stage ladder came back NON-MONOTONIC
 * (`ab-bytes` 448 MB > `ab-index` 267 MB at N=100, with the JS heap reading 208 MB vs 53 MB), which is
 * impossible for cumulative retention and means the sample was dominated by uncollected transients —
 * mp4box's parse buffers, the 4 MB range-probe bodies, the arrayBuffers each window slice allocates.
 * A stage cost differenced out of that is a measurement of GC timing, not of what a provider holds.
 * `HeapProfiler.collectGarbage` is a real major GC, unlike `--expose-gc`'s window.gc, and it is the
 * same collection the snapshot in part B takes implicitly — so both halves of this probe now measure
 * the same post-collection state.
 */
async function settleAndCollect(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage"); // second pass frees what the first made unreachable
  await cdp.send("HeapProfiler.disable");
  await cdp.detach();
  await new Promise((r) => setTimeout(r, 3000)); // let the OS reclaim the freed pages into the working set
}

async function takeHeapSnapshot(page: Page, outFile: string): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  const parts: string[] = [];
  cdp.on("HeapProfiler.addHeapSnapshotChunk", (e: { chunk: string }) => parts.push(e.chunk));
  await cdp.send("HeapProfiler.enable");
  // treatGlobalObjectsAsRoots keeps the window in the graph so retainer paths terminate somewhere
  // nameable rather than at a synthetic root.
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, treatGlobalObjectsAsRoots: true });
  await cdp.send("HeapProfiler.disable");
  const json = parts.join("");
  writeFileSync(outFile, json);
  return json;
}

interface Snapshot {
  nodeCount: number;
  nodeFieldCount: number;
  nodes: number[];
  edges: number[];
  edgeFieldCount: number;
  strings: string[];
  nodeTypes: string[];
  edgeTypes: string[];
  fieldIndex: (name: string) => number;
  edgeFieldIndex: (name: string) => number;
  firstEdge: Int32Array;
}

function parseSnapshot(json: string): Snapshot {
  const raw = JSON.parse(json) as {
    snapshot: { meta: { node_fields: string[]; node_types: unknown[]; edge_fields: string[]; edge_types: unknown[] }; node_count: number };
    nodes: number[];
    edges: number[];
    strings: string[];
  };
  const meta = raw.snapshot.meta;
  const nodeFieldCount = meta.node_fields.length;
  const edgeFieldCount = meta.edge_fields.length;
  const nodeCount = raw.snapshot.node_count;
  const ecIdx = meta.node_fields.indexOf("edge_count");
  // Edges are stored contiguously in node order; firstEdge[i] is node i's first edge INDEX (not offset).
  const firstEdge = new Int32Array(nodeCount + 1);
  let acc = 0;
  for (let i = 0; i < nodeCount; i += 1) {
    firstEdge[i] = acc;
    acc += raw.nodes[i * nodeFieldCount + ecIdx]!;
  }
  firstEdge[nodeCount] = acc;
  return {
    nodeCount,
    nodeFieldCount,
    nodes: raw.nodes,
    edges: raw.edges,
    edgeFieldCount,
    strings: raw.strings,
    nodeTypes: meta.node_types[0] as string[],
    edgeTypes: meta.edge_types[0] as string[],
    fieldIndex: (name) => meta.node_fields.indexOf(name),
    edgeFieldIndex: (name) => meta.edge_fields.indexOf(name),
    firstEdge,
  };
}

interface ClassTotal {
  klass: string;
  count: number;
  selfMB: number;
}

function classTotals(s: Snapshot): Map<string, ClassTotal> {
  const tIdx = s.fieldIndex("type");
  const nIdx = s.fieldIndex("name");
  const sIdx = s.fieldIndex("self_size");
  const out = new Map<string, ClassTotal>();
  for (let i = 0; i < s.nodeCount; i += 1) {
    const base = i * s.nodeFieldCount;
    const type = s.nodeTypes[s.nodes[base + tIdx]!] ?? "?";
    const name = s.strings[s.nodes[base + nIdx]!] ?? "";
    // Strings and numbers dominate by count and say nothing about a holder; keep them aggregated as
    // one bucket each rather than one per literal.
    const klass = type === "string" || type === "concatenated string" || type === "sliced string" ? "(string)" : `${type}:${name}`;
    const size = s.nodes[base + sIdx]! / 1048576;
    const cur = out.get(klass);
    if (cur) {
      cur.count += 1;
      cur.selfMB += size;
    } else out.set(klass, { klass, count: 1, selfMB: size });
  }
  return out;
}

/** Reverse-edge index, built lazily because it costs ~edgeCount ints. */
function buildRetainers(s: Snapshot): { offs: Int32Array; from: Int32Array } {
  const toIdx = s.edgeFieldIndex("to_node");
  const edgeCount = s.edges.length / s.edgeFieldCount;
  const counts = new Int32Array(s.nodeCount + 1);
  for (let e = 0; e < edgeCount; e += 1) {
    const to = s.edges[e * s.edgeFieldCount + toIdx]! / s.nodeFieldCount;
    counts[to]! += 1;
  }
  const offs = new Int32Array(s.nodeCount + 1);
  let acc = 0;
  for (let i = 0; i <= s.nodeCount; i += 1) {
    offs[i] = acc;
    acc += counts[i] ?? 0;
  }
  const cursor = offs.slice();
  const from = new Int32Array(acc);
  for (let node = 0; node < s.nodeCount; node += 1) {
    for (let e = s.firstEdge[node]!; e < s.firstEdge[node + 1]!; e += 1) {
      const to = s.edges[e * s.edgeFieldCount + toIdx]! / s.nodeFieldCount;
      from[cursor[to]!++] = node;
    }
  }
  return { offs, from };
}

function nodeLabel(s: Snapshot, i: number): string {
  const base = i * s.nodeFieldCount;
  const type = s.nodeTypes[s.nodes[base + s.fieldIndex("type")]!] ?? "?";
  const name = s.strings[s.nodes[base + s.fieldIndex("name")]!] ?? "";
  return `${type}:${name || "(anon)"}`;
}

/** One retainer path from `start` up to a root-ish node, shortest-first via BFS on reverse edges. */
function retainerPath(s: Snapshot, rev: { offs: Int32Array; from: Int32Array }, start: number, maxDepth = 12): string {
  const seen = new Set<number>([start]);
  let frontier: { node: number; path: number[] }[] = [{ node: start, path: [start] }];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: { node: number; path: number[] }[] = [];
    for (const item of frontier) {
      for (let k = rev.offs[item.node]!; k < rev.offs[item.node + 1]!; k += 1) {
        const parent = rev.from[k]!;
        if (seen.has(parent)) continue;
        seen.add(parent);
        const label = nodeLabel(s, parent);
        const path = [...item.path, parent];
        if (label.startsWith("synthetic:") || label.includes("Window") || label === "object:global") {
          return path.map((n) => nodeLabel(s, n)).reverse().join(" -> ");
        }
        next.push({ node: parent, path });
      }
    }
    if (!next.length) break;
    frontier = next.slice(0, 4000); // bound the fan-out; the shortest path is what matters
  }
  return frontier[0] ? frontier[0].path.map((n) => nodeLabel(s, n)).reverse().join(" -> ") + " -> (no root within depth)" : "(no retainer)";
}

async function main() {
  const corpora = [
    { label: "3s", dir: SHORT_DIR },
    { label: "120s", dir: LONG_DIR },
  ].filter((c) => c.dir);
  if (corpora.length !== 2) throw new Error("set BOTH DEBT019_MEDIA_SHORT and DEBT019_MEDIA_LONG — the whole question is the difference between them");
  mkdirSync(OUT_DIR, { recursive: true });

  console.log("PRECONDITIONS");
  console.log(`  PIXEL_BROWSER_CHANNEL : ${process.env.PIXEL_BROWSER_CHANNEL ?? "(unset -> chrome default)"}`);
  console.log(`  chrome.exe before run : ${processCount("chrome.exe")}`);
  console.log(`  node.exe before run   : ${processCount("node.exe")}`);
  for (const c of corpora) {
    const files = readdirSync(c.dir).filter((f) => /^src\d+\.mp4$/.test(f));
    const bytes = files.reduce((a, f) => a + statSync(path.join(c.dir, f)).size, 0);
    console.log(`  corpus ${c.label.padEnd(5)}         : ${files.length} files, ${(bytes / 1048576).toFixed(0)} MB total, ${(bytes / files.length / 1048576).toFixed(1)} MB/file`);
  }

  const vitePort = await getFreePort();
  const vite = startVite(vitePort);
  const origin = `http://127.0.0.1:${vitePort}`;
  const browserSrc = readFileSync(path.join(here, "debt019-attribution-browser.js"), "utf8");
  const rows: Row[] = [];
  const snapshots: { corpus: string; json: string }[] = [];

  try {
    await waitForServer(origin);
    console.log(`  build identity (root) : ${await assertServingThisWorktree(origin)}`);
    const servedDecoder = await (await fetch(`${origin}/src/export/webcodecs-decoder.ts`)).text();
    if (!servedDecoder.includes("wcAblationBuild")) throw new Error("served webcodecs-decoder.ts has no wcAblationBuild — stale build, refusing to measure");
    console.log(`  build identity (file) : webcodecs-decoder.ts served WITH wcAblationBuild (${servedDecoder.length}B) — this build, not a previous one\n`);

    for (const corpus of corpora) {
      const clips = readdirSync(corpus.dir).filter((f) => /^src\d+\.mp4$/.test(f)).sort();
      const mediaPort = await getFreePort();
      const mediaServer = await startMediaServer(mediaPort, corpus.dir);
      const mediaOrigin = `http://127.0.0.1:${mediaPort}`;
      try {
        for (const variant of [...VARIANTS, "snapshot"]) {
          const n = variant === "snapshot" ? SNAP_N : N;
          if (n > clips.length) continue;
          if (variant === "snapshot" && process.env.DEBT019_SKIP_SNAPSHOT) continue;
          assertZeroBrowserFloor(`debt019-attribution ${corpus.label}/${variant}`);
          const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL ?? "chrome", args: LAUNCH_ARGS });
          const page = await browser.newPage();
          await page.route(`${origin}/__pull_probe`, (r) =>
            r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>debt019-attr</title><body>" })
          );
          await page.goto(`${origin}/__pull_probe`);
          await page.evaluate("1");
          await new Promise((r) => setTimeout(r, 2500));
          const baseMB = chromeMemoryMB();

          const payload = JSON.stringify({
            n,
            variant: variant === "snapshot" ? "pull4" : variant,
            mediaOrigin,
            clips,
            pullFractions: PULL_FRACTIONS,
          });
          const info = (await page.evaluate(`(${browserSrc})(${payload})`)) as { jsHeapMB: number; stats: Record<string, number> };
          await new Promise((r) => setTimeout(r, 2500));
          await settleAndCollect(page);
          // Re-read the heap AFTER collection — `info.jsHeapMB` was sampled with the stage's transients
          // still live and reads high by 3-4x on the parse-heavy stages.
          const heapAfterMB = (await page.evaluate(
            "((performance.memory && performance.memory.usedJSHeapSize) || 0) / 1048576"
          )) as number;

          if (variant === "snapshot") {
            const file = path.join(OUT_DIR, `heap-${corpus.label}-n${n}.heapsnapshot`);
            const json = await takeHeapSnapshot(page, file);
            snapshots.push({ corpus: corpus.label, json });
            console.log(`  ${corpus.label.padEnd(5)} snapshot  N=${n}   ${(json.length / 1048576).toFixed(0)}MB of JSON -> ${file}`);
            await browser.close();
            continue;
          }

          const heldMB = chromeMemoryMB();
          const s = info.stats;
          const note =
            `bs ${s.byteSourceMB?.toFixed(0) ?? "-"}MB smp ${s.sampleCount || s.indexSamples || 0}` +
            ` idx ${((s.indexBytes ?? 0) / 1048576).toFixed(1)}MB copied ${((s.copiedBytes ?? 0) / 1048576).toFixed(0)}MB` +
            ` ranged ${((s.rangedBytes ?? 0) / 1048576).toFixed(0)}MB/${s.rangedSources ?? 0}src` +
            (s.buildNulls ? ` BUILD-NULLS ${s.buildNulls}` : "") +
            (s.getFrameCalls ? ` | getFrame ${s.getFrameCalls} null ${s.nulls} decodes ${s.decodeCalls} resets ${(s.resets1 ?? 0) - (s.resets0 ?? 0)} stream ${s.streaming} frag ${s.fragmented}` : "");
          rows.push({
            corpus: corpus.label,
            variant,
            baseMB,
            heldMB,
            deltaMB: heldMB - baseMB,
            perSrcMB: (heldMB - baseMB) / Math.max(1, n),
            jsHeapMB: heapAfterMB,
            note,
          });
          console.log(
            `  ${corpus.label.padEnd(5)} ${variant.padEnd(12)} N=${n}  base ${baseMB.toFixed(0)}MB -> held ${heldMB.toFixed(0)}MB ` +
              `(Δ ${(heldMB - baseMB).toFixed(0)}MB, ${((heldMB - baseMB) / Math.max(1, n)).toFixed(2)}MB/src, heap ${heapAfterMB.toFixed(1)}MB post-GC, ${info.jsHeapMB.toFixed(1)}MB pre-GC)  [${note}]`
          );
          await browser.close();
        }
      } finally {
        mediaServer.close();
      }
    }

    // ── PART A report ──────────────────────────────────────────────────────────
    console.log(`\n${"=".repeat(112)}`);
    console.log(`PART A — PER-TERM ABLATION, N=${N}. Each stage holds the REAL internals up to that point.`);
    console.log(`${"=".repeat(112)}`);
    console.log("stage          3s Δ/src   120s Δ/src   ratio    STAGE COST (120s minus previous stage, per source)");
    console.log("-".repeat(112));
    let prev3 = 0;
    let prev120 = 0;
    for (const variant of VARIANTS) {
      const a = rows.find((r) => r.corpus === "3s" && r.variant === variant);
      const b = rows.find((r) => r.corpus === "120s" && r.variant === variant);
      if (!a || !b) continue;
      console.log(
        `${variant.padEnd(14)} ${a.perSrcMB.toFixed(2).padStart(8)}   ${b.perSrcMB.toFixed(2).padStart(10)}   ` +
          `${(b.perSrcMB / Math.max(0.01, a.perSrcMB)).toFixed(2).padStart(5)}x   ` +
          `+${(b.perSrcMB - prev120).toFixed(2)} MB   (3s: +${(a.perSrcMB - prev3).toFixed(2)} MB)`
      );
      prev3 = a.perSrcMB;
      prev120 = b.perSrcMB;
    }
    console.log("-".repeat(112));
    console.log("JS heap by stage (MB total in the renderer):");
    for (const variant of VARIANTS) {
      const a = rows.find((r) => r.corpus === "3s" && r.variant === variant);
      const b = rows.find((r) => r.corpus === "120s" && r.variant === variant);
      if (a && b) console.log(`  ${variant.padEnd(14)} 3s ${a.jsHeapMB.toFixed(1).padStart(7)}   120s ${b.jsHeapMB.toFixed(1).padStart(7)}   diff ${(b.jsHeapMB - a.jsHeapMB).toFixed(1)} MB  (${((b.jsHeapMB - a.jsHeapMB) / N).toFixed(3)} MB/src)`);
    }

    // ── PART B report ──────────────────────────────────────────────────────────
    if (snapshots.length === 2) {
      console.log(`\n${"=".repeat(112)}`);
      console.log(`PART B — HEAP SNAPSHOT WITH RETAINER PATHS, N=${SNAP_N}, full provider (4 pulls).`);
      console.log(`${"=".repeat(112)}`);
      const parsed = snapshots.map((s) => ({ corpus: s.corpus, snap: parseSnapshot(s.json) }));
      const totals = parsed.map((p) => ({ corpus: p.corpus, snap: p.snap, totals: classTotals(p.snap) }));
      const short = totals.find((t) => t.corpus === "3s")!;
      const long = totals.find((t) => t.corpus === "120s")!;
      const sum = (t: Map<string, ClassTotal>) => [...t.values()].reduce((a, c) => a + c.selfMB, 0);
      console.log(`  total JS self size: 3s ${sum(short.totals).toFixed(1)} MB   120s ${sum(long.totals).toFixed(1)} MB   ` +
        `diff ${(sum(long.totals) - sum(short.totals)).toFixed(1)} MB = ${((sum(long.totals) - sum(short.totals)) / SNAP_N).toFixed(3)} MB/src`);
      console.log("");
      const keys = new Set([...short.totals.keys(), ...long.totals.keys()]);
      const diffs = [...keys]
        .map((k) => {
          const a = short.totals.get(k);
          const b = long.totals.get(k);
          return { klass: k, shortMB: a?.selfMB ?? 0, longMB: b?.selfMB ?? 0, diffMB: (b?.selfMB ?? 0) - (a?.selfMB ?? 0), longCount: b?.count ?? 0 };
        })
        .sort((x, y) => y.diffMB - x.diffMB)
        .slice(0, 15);
      console.log("  class                                          3s(MB)   120s(MB)   diff(MB)   diff/src(MB)   count(120s)");
      console.log("  " + "-".repeat(108));
      for (const d of diffs) {
        console.log(
          `  ${d.klass.slice(0, 44).padEnd(45)}${d.shortMB.toFixed(2).padStart(7)}${d.longMB.toFixed(2).padStart(11)}` +
            `${d.diffMB.toFixed(2).padStart(11)}${(d.diffMB / SNAP_N).toFixed(4).padStart(15)}${String(d.longCount).padStart(14)}`
        );
      }
      // ── The native objects, BY COUNT ───────────────────────────────────────
      // A `native:VideoFrame` node's SELF SIZE is the JS-side wrapper (tens of bytes); its pixels live
      // in GPU/renderer memory that no JS heap number includes. So the byte columns above structurally
      // CANNOT see a pinned decoded frame — which is exactly the term the working-set ladder can see
      // and cannot name. Counting them joins the two instruments: the snapshot says how many are held
      // and what holds them, and the frame's own geometry prices them.
      console.log("");
      console.log("  NATIVE OBJECTS BY COUNT — the terms the byte columns above are blind to:");
      console.log("  class                                          3s(count)  120s(count)   per-src 3s   per-src 120s");
      console.log("  " + "-".repeat(108));
      for (const k of ["native:VideoFrame", "native:EncodedVideoChunk", "native:VideoDecoder", "native:Blob", "native:system / JSArrayBufferData"]) {
        const a = short.totals.get(k);
        const b = long.totals.get(k);
        if (!a && !b) continue;
        console.log(
          `  ${k.padEnd(45)}${String(a?.count ?? 0).padStart(9)}${String(b?.count ?? 0).padStart(13)}` +
            `${((a?.count ?? 0) / SNAP_N).toFixed(2).padStart(13)}${((b?.count ?? 0) / SNAP_N).toFixed(2).padStart(15)}`
        );
      }

      console.log("");
      console.log("  RETAINER PATHS for the classes that differ (largest instances in the 120s snapshot):");
      const s = long.snap;
      const rev = buildRetainers(s);
      const tIdx = s.fieldIndex("type");
      const nIdx = s.fieldIndex("name");
      const szIdx = s.fieldIndex("self_size");
      // The native classes are walked UNCONDITIONALLY: their self size is a wrapper, so a byte
      // threshold would silently skip the one term this whole phase exists to name.
      const walk = [
        ...["native:VideoFrame", "native:EncodedVideoChunk"].map((klass) => ({ klass, diffMB: Number.NaN })),
        ...diffs.slice(0, 5),
      ];
      for (const d of walk) {
        if (!Number.isNaN(d.diffMB) && d.diffMB < 0.5) continue;
        if (!long.totals.has(d.klass)) continue;
        let bestNode = -1;
        let bestSize = -1;
        for (let i = 0; i < s.nodeCount; i += 1) {
          const base = i * s.nodeFieldCount;
          const type = s.nodeTypes[s.nodes[base + tIdx]!] ?? "?";
          const name = s.strings[s.nodes[base + nIdx]!] ?? "";
          const klass = type === "string" || type === "concatenated string" || type === "sliced string" ? "(string)" : `${type}:${name}`;
          if (klass !== d.klass) continue;
          const size = s.nodes[base + szIdx]!;
          if (size > bestSize) {
            bestSize = size;
            bestNode = i;
          }
        }
        if (bestNode < 0) continue;
        const size = Number.isNaN(d.diffMB)
          ? `${long.totals.get(d.klass)!.count} instances held`
          : `+${d.diffMB.toFixed(2)} MB total`;
        console.log(`\n  ${d.klass}  (${size}; largest JS shell ${(bestSize / 1048576).toFixed(4)} MB)`);
        console.log(`    ${retainerPath(s, rev, bestNode)}`);
      }
    }

    console.log(`\n  chrome.exe after run  : ${processCount("chrome.exe")}`);
  } finally {
    await stopProcess(vite);
    reapAutomationBrowsers();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
