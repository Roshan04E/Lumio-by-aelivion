/**
 * Composited-FRAME cache gate — ADR-021 step 3b.
 *
 * WHY THIS EXISTS, AND WHY IT WAS WRITTEN BEFORE THE CACHE IT GUARDS.
 *
 * The failure that matters for a frame cache is a STALE SERVE, and a stale serve does not look like a
 * caching bug. It looks like a rendering bug: the picture is wrong, or frozen, or a frame late, and
 * every instinct sends you into the compositor. `render:compare:pixels` cannot see it at all — it
 * renders exactly ONE frame per fixture, and one frame is the only situation in which a frame cache
 * is trivially correct. So the arm that catches a stale serve has to exist before there is a cache
 * that could produce one; otherwise the first stale serve is found by a user, and found as the wrong
 * defect.
 *
 * THE ORACLE. Every scenario renders a sequence two ways and compares frame by frame:
 *   - WARM: one compositor, frame cache ON, keys declared exactly as the product declares them.
 *   - COLD: a fresh compositor per frame, frame cache OFF. No cache can exist, so this is the truth.
 * Any divergence means the cache served pixels the renderer would not have produced.
 *
 * WHAT ELSE IT ASSERTS, because parity alone is a bar a cache passes by never hitting:
 *   - REAL HIT REGISTRATION. A scrub-back must register HITS on the cache's own counters, and the
 *     count must be the one the access pattern predicts. Warm-vs-cold parity with zero hits is a
 *     cache that is switched off, and it passes every correctness check in this file.
 *   - THE SETTLE GATE. An unsettled frame must be DECLINED, not stored. This is the arm that stops
 *     the cache memoizing a half-decoded picture under a key that claims to mean the finished one.
 *   - I-P9 EVICTION. Under a squeezed budget the cache must evict, stay correct, and — on a CYCLIC
 *     access pattern larger than capacity — do better than LRU would. That last one is a measurement,
 *     not an assertion about the code: see the `loop-past-capacity` scenario.
 *
 * CAN THIS GATE ACTUALLY GO RED? A gate that cannot fail proves nothing, and the cheapest way to
 * believe this one is to break the key on purpose and watch it fail:
 *
 *   FRAME_CACHE_SABOTAGE=drop-t      pnpm --filter @orreris/worker flarex:frame-cache-gate
 *   FRAME_CACHE_SABOTAGE=drop-graph  pnpm --filter @orreris/worker flarex:frame-cache-gate
 *
 * `drop-t` omits the time term (every frame collides → a frozen picture); `drop-graph` omits the
 * graph content hash (an edit is invisible → the pre-edit picture is served forever). BOTH must make
 * this gate fail. The sabotage is entirely gate-side — it changes the key this harness declares, and
 * touches no product code — so running it costs nothing and leaves nothing behind.
 *
 * Run (dev server must be up):
 *   pnpm --filter @orreris/worker flarex:frame-cache-gate
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker flarex:frame-cache-gate
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fsSpecifier = (rel: string) => `/@fs/${path.join(repoRoot, rel).replace(/\\/g, "/")}`;

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";
const W = 320;
const H = 180;
/** Sabotage mode — see the header. "" = the real key. */
const SABOTAGE = process.env.FRAME_CACHE_SABOTAGE ?? "";

interface ScenarioResult {
  name: string;
  divergentFrames: number[];
  hits: number;
  misses: number;
  stores: number;
  declined: number;
  evictions: number;
  bytes: number;
  budgetBytes: number;
  distinctWarm: number;
  distinctCold: number;
  /** Frames the harness EXPECTED to be served from cache, given the access pattern and capacity. */
  expectedHits: number;
  /** Hit rate an LRU policy would have achieved on this same access order (cyclic-access evidence). */
  lruHitRate?: number;
  /** Hit rate the shipped random policy achieved. */
  actualHitRate?: number;
  error?: string;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex:frame-cache-gate" });

  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage();
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const results: ScenarioResult[] = await page.evaluate(
    async (payload: { width: number; height: number; sabotage: string; mods: Record<string, string> }) => {
      const { width, height, sabotage, mods } = payload;
      const compositorMod = await import(/* @vite-ignore */ mods.compositor!);
      const compileMod = await import(/* @vite-ignore */ mods.compile!);
      const registryMod = await import(/* @vite-ignore */ mods.registry!);
      const nodeDefsMod = await import(/* @vite-ignore */ mods.nodeDefs!);
      const builtinsMod = await import(/* @vite-ignore */ mods.builtins!);
      const hashMod = await import(/* @vite-ignore */ mods.contentHash!);
      const policyMod = await import(/* @vite-ignore */ mods.framePolicy!);

      const { SceneCompositor } = compositorMod;
      const { compileFlarexComp } = compileMod;
      const { createFlarexComp } = registryMod;
      const { createFlarexNode } = nodeDefsMod;
      const { builtinFragmentEffectId } = builtinsMod;
      const { computeFlarexContentHashes } = hashMod;
      const { planFrameCacheEviction, makeFrameCacheRandom } = policyMod;

      // NOTE (probe-evaluate rule): no function-valued `const`s at module scope inside evaluate —
      // tsx's keepNames wraps those in `__name()`, which does not exist in the page. Function
      // DECLARATIONS are fine, and are what this file uses throughout.
      function hashPixels(data: Uint8ClampedArray): string {
        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        for (let i = 0; i < data.length; i += 4) {
          h1 = ((h1 ^ data[i]!) * 16777619) >>> 0;
          h1 = ((h1 ^ data[i + 1]!) * 16777619) >>> 0;
          h2 = ((h2 ^ data[i + 2]!) * 16777619) >>> 0;
          h2 = ((h2 ^ data[i + 3]!) * 16777619) >>> 0;
        }
        return `${h1.toString(16)}:${h2.toString(16)}`;
      }

      const readback = document.createElement("canvas");
      readback.width = width;
      readback.height = height;
      const readCtx = readback.getContext("2d", { willReadFrequently: true })!;
      function snapshot(glCanvas: HTMLCanvasElement): string {
        readCtx.clearRect(0, 0, width, height);
        readCtx.drawImage(glCanvas, 0, 0, width, height);
        return hashPixels(readCtx.getImageData(0, 0, width, height).data);
      }

      /**
       * A stand-in for live media that is a pure FUNCTION OF TIME — which is the property the whole
       * `(graph hash, t)` key rests on. Same t must mean the same pixels, or a frame cache is
       * unsound no matter how it is keyed, and a scrub back over played ground would be a lie.
       */
      function paintAtTime(c: HTMLCanvasElement, frame: number): void {
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = `rgb(${(frame * 37) % 256}, ${(frame * 91) % 256}, ${(frame * 13) % 256})`;
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect((frame * 5) % 56, 0, 8, 64);
      }

      function makeComp(id: string) {
        const comp = createFlarexComp(id, "FC");
        const fx = createFlarexNode("filter", `${id}_fx`);
        fx.params = { ...fx.params, effectId: builtinFragmentEffectId("pixelate"), effectParams: "" };
        comp.nodes[`${id}_fx`] = fx;
        comp.edges = [
          { id: "e1", from: { nodeId: `${id}_in`, socket: "out" }, to: { nodeId: `${id}_fx`, socket: "in" } },
          { id: "e2", from: { nodeId: `${id}_fx`, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } },
        ];
        return comp;
      }

      /**
       * A comp whose edit is VISIBLE. `edit-invalidates` needs an edit that moves pixels, not merely
       * one that moves the content hash: with a pixel-invisible edit the warm/cold oracle compares two
       * identical pictures and cannot fail, so the arm that catches a stale serve would be silently
       * inert while its counter-based sibling did all the work. That is exactly what the first
       * `drop-graph` sabotage run showed — the sabotage was caught only by the hit COUNT, and the
       * divergence check reported a clean sweep. Exposure on a colour node is unambiguous.
       */
      function makeGradeComp(id: string) {
        const comp = createFlarexComp(id, "FCG");
        const grade = createFlarexNode("colorCorrect", `${id}_fx`);
        comp.nodes[`${id}_fx`] = grade;
        comp.edges = [
          { id: "e1", from: { nodeId: `${id}_in`, socket: "out" }, to: { nodeId: `${id}_fx`, socket: "in" } },
          { id: "e2", from: { nodeId: `${id}_fx`, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } },
        ];
        return comp;
      }

      /**
       * The key, declared exactly as a host must declare it: the GRAPH term comes from the ADR-009
       * content hashes (which fold resolved params, topology and font identity by construction), and
       * NOT from the draw list — the draw list is a downstream artifact of the very computation the
       * cache exists to skip, so keying on it would be keying on the answer.
       */
      function frameKey(comp: unknown, rootId: string, frame: number): string {
        const hashes = computeFlarexContentHashes(comp as never, frame / 30);
        const graph = hashes.get(rootId) ?? "∅";
        if (sabotage === "drop-t") return `v1|${width}x${height}|${graph}`;
        if (sabotage === "drop-graph") return `v1|${width}x${height}|t${(frame / 30).toFixed(6)}`;
        return `v1|${width}x${height}|${graph}|t${(frame / 30).toFixed(6)}`;
      }

      function runScenario(
        name: string,
        comp: unknown,
        rootId: string,
        order: number[],
        opts: {
          /** Frames whose picture the host declares UNSETTLED (a source stale/not ready). */
          unsettled?: (frame: number) => boolean;
          editPerFrame?: (comp: unknown, frame: number, index: number) => void;
          budgetBytes?: number;
          /** Frames expected to be served from cache. Computed by the harness, not read back. */
          expectedHits?: number;
          /** Also compute what LRU would have done on this order (I-P9 evidence). */
          compareLru?: { capacityFrames: number };
        },
      ): ScenarioResult {
        const result: ScenarioResult = {
          name,
          divergentFrames: [],
          hits: 0,
          misses: 0,
          stores: 0,
          declined: 0,
          evictions: 0,
          bytes: 0,
          budgetBytes: 0,
          distinctWarm: 0,
          distinctCold: 0,
          expectedHits: opts.expectedHits ?? 0,
        };
        try {
          const warmCanvas = document.createElement("canvas");
          const warmOpts: Record<string, unknown> = {};
          if (opts.budgetBytes !== undefined) warmOpts.frameCacheBudgetBytes = opts.budgetBytes;
          const warm = new SceneCompositor(warmCanvas, width, height, warmOpts);
          const warmSource = document.createElement("canvas");
          warmSource.width = 64;
          warmSource.height = 64;
          const warmHashes: string[] = [];

          for (let i = 0; i < order.length; i++) {
            const frame = order[i]!;
            opts.editPerFrame?.(comp, frame, i);
            paintAtTime(warmSource, frame);
            const draw = compileFlarexComp(comp, {
              compWidth: width,
              compHeight: height,
              renderScale: 1,
              timeSeconds: frame / 30,
              frameTimeSeconds: frame / 30,
              hostSourceDraw: {
                debugLayerId: "src",
                source: warmSource,
                sourceWidth: 64,
                sourceHeight: 64,
                fit: "fill",
                transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
                blendMode: "normal",
              },
              matteCache: null,
            });
            warm.renderFrame({
              width,
              height,
              backgroundColor: "#000000",
              layers: draw ? [draw] : [],
              frameCache: { key: frameKey(comp, rootId, frame), storable: !opts.unsettled?.(frame) },
            });
            warmHashes.push(snapshot(warmCanvas));
          }

          const stats = warm.frameCacheStats?.() ?? null;
          if (stats) {
            result.hits = stats.hits;
            result.misses = stats.misses;
            result.stores = stats.stores;
            result.declined = stats.declined;
            result.evictions = stats.evictions;
            result.bytes = stats.bytes;
            result.budgetBytes = stats.budgetBytes;
          }
          warm.dispose?.();

          // COLD ORACLE: a new compositor per frame, cache explicitly off. Same order, same edits.
          const coldHashes: string[] = [];
          for (let i = 0; i < order.length; i++) {
            const frame = order[i]!;
            opts.editPerFrame?.(comp, frame, i);
            const coldCanvas = document.createElement("canvas");
            const cold = new SceneCompositor(coldCanvas, width, height, { frameCache: false });
            const coldSource = document.createElement("canvas");
            coldSource.width = 64;
            coldSource.height = 64;
            paintAtTime(coldSource, frame);
            const draw = compileFlarexComp(comp, {
              compWidth: width,
              compHeight: height,
              renderScale: 1,
              timeSeconds: frame / 30,
              frameTimeSeconds: frame / 30,
              hostSourceDraw: {
                debugLayerId: "src",
                source: coldSource,
                sourceWidth: 64,
                sourceHeight: 64,
                fit: "fill",
                transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
                blendMode: "normal",
              },
              matteCache: null,
            });
            cold.renderFrame({ width, height, backgroundColor: "#000000", layers: draw ? [draw] : [] });
            coldHashes.push(snapshot(coldCanvas));
            cold.dispose?.();
          }

          for (let i = 0; i < order.length; i++) {
            if (warmHashes[i] !== coldHashes[i]) result.divergentFrames.push(order[i]!);
          }
          result.distinctWarm = new Set(warmHashes).size;
          result.distinctCold = new Set(coldHashes).size;

          // I-P9 evidence: simulate BOTH policies over this same access order at the same capacity.
          // Pure simulation, no GL — the policy is a pure function precisely so this is cheap.
          if (opts.compareLru) {
            const cap = opts.compareLru.capacityFrames;
            let lruHits = 0;
            const lru: number[] = [];
            for (const frame of order) {
              const at = lru.indexOf(frame);
              if (at >= 0) {
                lruHits += 1;
                lru.splice(at, 1);
                lru.push(frame);
                continue;
              }
              lru.push(frame);
              if (lru.length > cap) lru.shift(); // evict least-recently-used
            }
            let randomHits = 0;
            const rng = makeFrameCacheRandom();
            let pool: { cacheKey: string; bytes: number; lastAccessFrame: number }[] = [];
            let counter = 0;
            for (const frame of order) {
              counter += 1;
              const key = String(frame);
              const found = pool.find((e) => e.cacheKey === key);
              if (found) {
                randomHits += 1;
                found.lastAccessFrame = counter;
                continue;
              }
              pool.push({ cacheKey: key, bytes: 1, lastAccessFrame: counter });
              const doomed = planFrameCacheEviction(
                pool,
                { frame: counter, bytes: pool.length, entries: pool.length, budgetBytes: cap, maxEntries: cap },
                rng,
              );
              pool = pool.filter((e) => !doomed.includes(e.cacheKey));
            }
            result.lruHitRate = lruHits / order.length;
            result.actualHitRate = randomHits / order.length;
          }
        } catch (error) {
          result.error = String(error);
        }
        return result;
      }

      function range(n: number): number[] {
        return Array.from({ length: n }, (_, i) => i);
      }

      const out: ScenarioResult[] = [];

      // (1) SCRUB BACK over ground already played. The headline claim: 100% hit inside capacity.
      //     24 forward (all miss, all stored) then the same 24 backward (all must hit).
      out.push(
        runScenario("scrub-back", makeComp("fc1"), "fc1_fx", [...range(24), ...range(24).reverse()], {
          expectedHits: 24,
        }),
      );

      // (2) LOOP a range inside capacity — the other thing playback actually is. 3 passes over 12
      //     frames: pass 1 misses, passes 2 and 3 must hit every frame.
      out.push(
        runScenario("loop-in-capacity", makeComp("fc2"), "fc2_fx", [...range(12), ...range(12), ...range(12)], {
          expectedHits: 24,
        }),
      );

      // (3) AN EDIT MUST INVALIDATE. A param changes mid-sweep, then the SAME times are revisited.
      //     The graph hash moves, so the revisit must re-render — serving the pre-edit picture here is
      //     the stale serve this gate exists for, and is exactly what `drop-graph` sabotage produces.
      out.push(
        runScenario("edit-invalidates", makeGradeComp("fc3"), "fc3_fx", [...range(8), ...range(8)], {
          // The edit lands BETWEEN the two passes: pass 1 renders at exposure 0 and fills the
          // cache, pass 2 re-walks the SAME times at exposure 1.5. Every frame of pass 2 must miss. Indexed by
          // position rather than by time, so the warm and cold arms edit identically.
          editPerFrame: (c, _frame, index) => {
            const nodes = (c as { nodes: Record<string, { params: Record<string, unknown> }> }).nodes;
            const node = nodes.fc3_fx!;
            node.params = { ...node.params, exposure: index % 16 < 8 ? 0 : 1.5 };
          },
        }),
      );

      // (4) THE SETTLE GATE. Odd frames are declared UNSETTLED. They must be DECLINED — rendered and
      //     not stored — so a revisit re-renders rather than serving a half-decoded picture.
      out.push(
        runScenario("unsettled-declined", makeComp("fc4"), "fc4_fx", [...range(12), ...range(12)], {
          unsettled: (frame) => frame % 2 === 1,
          expectedHits: 6,
        }),
      );

      // (5) EVICTION + I-P9. A cyclic access pattern LARGER than capacity — the case where LRU is the
      //     textbook worst case and evicts precisely the frame wanted next. Correctness must hold, the
      //     cache must actually evict, and the policy comparison is reported as a measurement.
      out.push(
        runScenario("loop-past-capacity", makeComp("fc5"), "fc5_fx", [...range(20), ...range(20), ...range(20)], {
          budgetBytes: width * height * 4 * 8, // capacity ≈ 8 frames against a 20-frame cycle
          compareLru: { capacityFrames: 8 },
        }),
      );

      return out;
    },
    {
      width: W,
      height: H,
      sabotage: SABOTAGE,
      mods: {
        compositor: fsSpecifier("packages/shared/src/color/scene-compositor.ts"),
        compile: fsSpecifier("packages/shared/src/flarex/compile-flarex.ts"),
        registry: fsSpecifier("packages/shared/src/flarex/registry.ts"),
        nodeDefs: fsSpecifier("packages/shared/src/flarex/node-defs.ts"),
        builtins: fsSpecifier("packages/shared/src/color/fragment-effects/builtins.ts"),
        contentHash: fsSpecifier("packages/shared/src/flarex/content-hash.ts"),
        framePolicy: fsSpecifier("packages/shared/src/color/composited-frame-cache.ts"),
      },
    },
  );

  await browser.close();

  let failures = 0;
  const fail = (msg: string) => {
    failures += 1;
    console.error(`FAIL  ${msg}`);
  };
  const ok = (msg: string) => console.log(`  ok  ${msg}`);

  if (SABOTAGE) console.log(`\n*** SABOTAGE MODE "${SABOTAGE}" — this run is EXPECTED to fail. ***`);

  for (const r of results) {
    console.log(
      `\n[${r.name}] hits=${r.hits} misses=${r.misses} stores=${r.stores} declined=${r.declined} evictions=${r.evictions} ` +
        `bytes=${(r.bytes / 1048576).toFixed(1)}MB/${(r.budgetBytes / 1048576).toFixed(0)}MB distinct warm=${r.distinctWarm} cold=${r.distinctCold}`,
    );
    if (r.error) {
      fail(`${r.name}: scenario threw — ${r.error}`);
      continue;
    }

    // (A) The core assertion: a cached frame must be indistinguishable from an uncached render.
    if (r.divergentFrames.length > 0) {
      fail(
        `${r.name}: warm (cached) diverged from cold (uncached) on ${r.divergentFrames.length} frame(s): ` +
          `[${r.divergentFrames.slice(0, 8).join(", ")}${r.divergentFrames.length > 8 ? ", …" : ""}] — a STALE SERVE`,
      );
    } else {
      ok(`${r.name}: every frame matches an uncached render (no stale serves)`);
    }

    // (B) The picture must still MOVE. A frozen warm sweep is what a t-blind key produces.
    if (r.distinctCold > 1 && r.distinctWarm <= 1) {
      fail(`${r.name}: warm produced ONE distinct frame while cold produced ${r.distinctCold} — the picture is frozen`);
    } else if (r.distinctCold > 1) {
      ok(`${r.name}: picture advances across the sweep (${r.distinctWarm} distinct frames)`);
    }

    // (C) Memory stays bounded.
    if (r.budgetBytes > 0 && r.bytes > r.budgetBytes) {
      fail(`${r.name}: cache holds ${(r.bytes / 1048576).toFixed(1)}MB, over its ${(r.budgetBytes / 1048576).toFixed(0)}MB budget`);
    } else {
      ok(`${r.name}: cache stays within its GPU budget`);
    }

    // (D) REAL HIT REGISTRATION — the check that separates "correct" from "switched off". Parity is
    //     free for a cache that never serves anything, so a scenario with a predicted hit count must
    //     meet it exactly: fewer means the cache is not working, MORE means it is serving frames the
    //     access pattern says it should not have.
    if (r.expectedHits > 0) {
      if (r.hits !== r.expectedHits) {
        fail(`${r.name}: expected exactly ${r.expectedHits} cache hits from this access pattern, got ${r.hits}`);
      } else {
        ok(`${r.name}: registered exactly the ${r.expectedHits} hits the access pattern predicts`);
      }
    }
  }

  // (E) The settle gate must have DECLINED, not merely rendered correctly.
  const settle = results.find((r) => r.name === "unsettled-declined");
  if (settle && !settle.error) {
    if (settle.declined !== 12) {
      fail(`unsettled-declined: 12 frames were declared unsettled but ${settle.declined} were declined — unsettled frames are being cached`);
    } else {
      ok(`unsettled-declined: every unsettled frame was declined rather than stored`);
    }
  }

  // (F) An edit must invalidate: the second pass over the same times must NOT be served from cache.
  const edit = results.find((r) => r.name === "edit-invalidates");
  if (edit && !edit.error) {
    if (edit.hits !== 0) {
      fail(`edit-invalidates: ${edit.hits} frame(s) were served from cache after a param edit — the graph term is not in the key`);
    } else {
      ok(`edit-invalidates: every revisited time re-rendered after the edit (0 hits, ${edit.misses} misses)`);
    }
  }

  // (G) I-P9, reported as the measurement it is rather than asserted as a constant.
  const cyclic = results.find((r) => r.name === "loop-past-capacity");
  if (cyclic && !cyclic.error) {
    if (cyclic.evictions <= 0) {
      fail(`loop-past-capacity: budget was squeezed below the cycle length but nothing was evicted — the retention policy did not run`);
    } else {
      ok(`loop-past-capacity: retention ran (${cyclic.evictions} evictions) and stayed pixel-correct`);
    }
    if (cyclic.lruHitRate !== undefined && cyclic.actualHitRate !== undefined) {
      console.log(
        `      I-P9: on this cyclic order at capacity 8/20 — LRU ${(cyclic.lruHitRate * 100).toFixed(1)}%, shipped random ${(cyclic.actualHitRate * 100).toFixed(1)}%`,
      );
      if (cyclic.actualHitRate <= cyclic.lruHitRate) {
        fail(`loop-past-capacity: the shipped policy is no better than LRU on a cyclic pattern — I-P9's ruling does not hold for this implementation`);
      } else {
        ok(`loop-past-capacity: the shipped policy beats LRU on cyclic access, as I-P9 requires`);
      }
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    if (SABOTAGE) console.error(`(SABOTAGE "${SABOTAGE}" was active — failing here is the POINT: it proves this gate can tell the answers apart.)`);
    process.exit(1);
  }
  if (SABOTAGE) {
    console.error(`\nSABOTAGE "${SABOTAGE}" was active and the gate still PASSED. The gate cannot tell a broken key from a correct one, so its green runs mean nothing.`);
    process.exit(1);
  }
  console.log("\nflarex composited-frame cache gate: all checks passed");
}

void main();
