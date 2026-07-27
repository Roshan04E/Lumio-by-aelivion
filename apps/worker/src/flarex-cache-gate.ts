/**
 * Flarex content-cache SEQUENCE gate (evaluation engine, Slice 2 — commit 3c-C).
 *
 * WHY THIS EXISTS. `render:compare:pixels` renders exactly ONE frame per fixture, so it is structurally
 * blind to any bug that only appears ACROSS frames — which is precisely the failure mode a cache has.
 * That blindness let a real one ship: the content-addressed cache keyed a materialized node without any
 * source-content term, so a subtree whose only dynamic input was live media produced the SAME key every
 * frame. The compositor's hit path composites the cached artifact and skips the children render outright,
 * so a fanned-out `MediaIn` served its first decoded frame forever — a permanently frozen clip that all 8
 * single-frame Flarex fixtures happily passed.
 *
 * THE GATE. For each scenario, render a SEQUENCE of frames two ways and compare frame by frame:
 *   - WARM: one long-lived `SceneCompositor` — the cache accumulates exactly as it does in the editor.
 *   - COLD: a fresh `SceneCompositor` per frame — no cache can possibly exist.
 * Cold is the oracle. Any divergence means the cache served pixels the renderer would not have produced,
 * i.e. a stale hit. That is the assertion the single-frame gate cannot make.
 *
 * It also asserts the two things that keep the cache HONEST rather than merely correct:
 *   - REUSE: a static comp must actually register cache hits. A cache that never hits is trivially
 *     parity-clean and completely worthless, so correctness alone is not a passing bar.
 *   - BUDGET: a per-frame-varying comp must stay under the byte budget across a long sweep. Before
 *     commit 3c-B this allocated a fresh ~8MB render target every frame until the context was lost.
 *
 * Run (dev server must be up):
 *   pnpm --filter @orreris/worker flarex:cache-gate
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker flarex:cache-gate
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fsSpecifier = (rel: string) => `/@fs/${path.join(repoRoot, rel).replace(/\\/g, "/")}`;

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";
const FRAMES = Number(process.env.FLAREX_GATE_FRAMES ?? 24);
const W = 320;
const H = 180;

interface ScenarioResult {
  name: string;
  /** Frame indices where the warm (cached) render disagreed with the cold (uncached) oracle. */
  divergentFrames: number[];
  hits: number;
  misses: number;
  promotions: number;
  evictions: number;
  peakBytes: number;
  budgetBytes: number;
  /** Distinct pixel hashes across the warm sweep — 1 means the picture never changed (a freeze). */
  distinctWarmFrames: number;
  /** Distinct pixel hashes across the cold sweep — the ground truth for how many it SHOULD be. */
  distinctColdFrames: number;
  error?: string;
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage();
  // esbuild/vite dev helper shim, matching the sibling probes.
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const results: ScenarioResult[] = await page.evaluate(
    async (payload: { frames: number; width: number; height: number; mods: Record<string, string> }) => {
      const { frames, width, height, mods } = payload;
      const compositorMod = await import(/* @vite-ignore */ mods.compositor!);
      const compileMod = await import(/* @vite-ignore */ mods.compile!);
      const registryMod = await import(/* @vite-ignore */ mods.registry!);
      const nodeDefsMod = await import(/* @vite-ignore */ mods.nodeDefs!);
      const builtinsMod = await import(/* @vite-ignore */ mods.builtins!);

      const { SceneCompositor } = compositorMod;
      const { compileFlarexComp } = compileMod;
      const { createFlarexComp } = registryMod;
      const { createFlarexNode } = nodeDefsMod;
      const { builtinFragmentEffectId } = builtinsMod;

      /** Cheap order-sensitive pixel digest — enough to detect "these two frames differ at all". */
      const hashPixels = (data: Uint8ClampedArray): string => {
        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        for (let i = 0; i < data.length; i += 4) {
          h1 = ((h1 ^ data[i]!) * 16777619) >>> 0;
          h1 = ((h1 ^ data[i + 1]!) * 16777619) >>> 0;
          h2 = ((h2 ^ data[i + 2]!) * 16777619) >>> 0;
          h2 = ((h2 ^ data[i + 3]!) * 16777619) >>> 0;
        }
        return `${h1.toString(16)}:${h2.toString(16)}`;
      };

      const readback = document.createElement("canvas");
      readback.width = width;
      readback.height = height;
      const readCtx = readback.getContext("2d", { willReadFrequently: true })!;
      const snapshot = (glCanvas: HTMLCanvasElement): string => {
        readCtx.clearRect(0, 0, width, height);
        readCtx.drawImage(glCanvas, 0, 0, width, height);
        return hashPixels(readCtx.getImageData(0, 0, width, height).data);
      };

      /** A stand-in for live media: a canvas whose pixels AND declared version change per frame. */
      const makeSourceCanvas = (): HTMLCanvasElement => {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        return c;
      };
      const paint = (c: HTMLCanvasElement, frame: number): void => {
        const ctx = c.getContext("2d")!;
        // A per-frame colour + a moving bar: a stale artifact shows the WRONG colour and a frozen bar.
        ctx.fillStyle = `rgb(${(frame * 37) % 256}, ${(frame * 91) % 256}, ${(frame * 13) % 256})`;
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect((frame * 5) % 56, 0, 8, 64);
      };

      const layerDraw = (source: HTMLCanvasElement, sourceVersion: number | undefined) => ({
        debugLayerId: "src",
        source,
        sourceWidth: 64,
        sourceHeight: 64,
        fit: "fill" as const,
        transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
        blendMode: "normal" as const,
        sourceVersion,
      });

      /**
       * A filter fanned out to BOTH merge inputs → `fanout > 1` AND enough GPU work to clear the
       * materialize cost threshold → the node seals and its artifact is cached.
       *
       * The filter is load-bearing: with a BARE MediaIn as the shared node the evaluator (correctly)
       * declines to materialize a zero-pass leaf, nothing is cached, and this gate would silently
       * degrade into asserting nothing — which its own "zero cache hits" check exists to catch.
       */
      const fanoutComp = (id: string) => {
        const comp = createFlarexComp(id, "Fan");
        const fx = createFlarexNode("filter", `${id}_fx`);
        fx.params = { ...fx.params, effectId: builtinFragmentEffectId("pixelate"), effectParams: "" };
        comp.nodes[`${id}_fx`] = fx;
        comp.nodes[`${id}_merge`] = createFlarexNode("merge", `${id}_merge`);
        comp.edges = [
          { id: "e0", from: { nodeId: `${id}_in`, socket: "out" }, to: { nodeId: `${id}_fx`, socket: "in" } },
          { id: "e1", from: { nodeId: `${id}_fx`, socket: "out" }, to: { nodeId: `${id}_merge`, socket: "bg" } },
          { id: "e2", from: { nodeId: `${id}_fx`, socket: "out" }, to: { nodeId: `${id}_merge`, socket: "fg" } },
          { id: "e3", from: { nodeId: `${id}_merge`, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } },
        ];
        return comp;
      };

      /** A materialized TIME-VARYING filter — its cache key changes every frame (the leak shape). */
      const timeVaryingComp = (id: string) => {
        const comp = createFlarexComp(id, "T");
        const filter = createFlarexNode("filter", `${id}_flt`);
        filter.params = { ...filter.params, effectId: builtinFragmentEffectId("glitchFx"), effectParams: "" };
        comp.nodes[`${id}_flt`] = filter;
        comp.edges = [
          { id: "e1", from: { nodeId: `${id}_in`, socket: "out" }, to: { nodeId: `${id}_flt`, socket: "in" } },
          { id: "e2", from: { nodeId: `${id}_flt`, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } },
        ];
        return comp;
      };

      const runScenario = (
        name: string,
        comp: unknown,
        opts: {
          animateSource: boolean;
          materializeIds?: string[];
          /** Walk time BACKWARD (a scrub). A cache that quietly assumes monotonic playback breaks here. */
          reverse?: boolean;
          /** Mutate a node param every frame, so the comp version + content hash churn per frame. */
          editPerFrame?: (comp: unknown, frame: number) => void;
          /** Shrink the cache's GPU budget so eviction actually engages within a short sweep. */
          budgetBytes?: number;
        },
      ): ScenarioResult => {
        const result: ScenarioResult = {
          name,
          divergentFrames: [],
          hits: 0,
          misses: 0,
          promotions: 0,
          evictions: 0,
          peakBytes: 0,
          budgetBytes: 0,
          distinctWarmFrames: 0,
          distinctColdFrames: 0,
        };
        try {
          const lower = (frame: number, sourceCanvas: HTMLCanvasElement) => ({
            compWidth: width,
            compHeight: height,
            renderScale: 1,
            timeSeconds: frame / 30,
            frameTimeSeconds: frame / 30,
            // Live media declares a NEW version per frame; a static source keeps one forever.
            hostSourceDraw: layerDraw(sourceCanvas, opts.animateSource ? frame + 1 : 1),
            matteCache: null,
            ...(opts.materializeIds ? { materializeNodeIds: new Set(opts.materializeIds) } : {}),
          });

          // Frame ORDER: playback walks forward, a scrub walks backward. Both must produce the same
          // pixels for a given frame — the cache must key on content, never on arrival order.
          const order = Array.from({ length: frames }, (_, i) => (opts.reverse ? frames - 1 - i : i));

          // WARM: one compositor for the whole sweep — the cache lives across frames.
          const warmCanvas = document.createElement("canvas");
          const warm = new SceneCompositor(
            warmCanvas,
            width,
            height,
            opts.budgetBytes === undefined ? undefined : { contentCacheBudgetBytes: opts.budgetBytes },
          );
          const warmSource = makeSourceCanvas();
          const warmHashes: string[] = [];
          for (const frame of order) {
            opts.editPerFrame?.(comp, frame);
            paint(warmSource, opts.animateSource ? frame : 0);
            const draw = compileFlarexComp(comp, lower(frame, warmSource));
            warm.renderFrame({ width, height, backgroundColor: "#000000", layers: draw ? [draw] : [] });
            warmHashes.push(snapshot(warmCanvas));
          }
          const stats = warm.contentCacheStats?.() ?? null;
          if (stats) {
            result.hits = stats.hits;
            result.misses = stats.misses;
            result.promotions = stats.promotions;
            result.evictions = stats.evictions;
            result.peakBytes = stats.bytes;
            result.budgetBytes = stats.budgetBytes;
          }
          warm.dispose?.();

          // COLD: a brand-new compositor per frame — no cache can exist. This is the oracle.
          // Walked in the SAME order so any per-frame edit lands identically in both arms.
          const coldHashes: string[] = [];
          for (const frame of order) {
            opts.editPerFrame?.(comp, frame);
            const coldCanvas = document.createElement("canvas");
            const cold = new SceneCompositor(coldCanvas, width, height);
            const coldSource = makeSourceCanvas();
            paint(coldSource, opts.animateSource ? frame : 0);
            const draw = compileFlarexComp(comp, lower(frame, coldSource));
            cold.renderFrame({ width, height, backgroundColor: "#000000", layers: draw ? [draw] : [] });
            coldHashes.push(snapshot(coldCanvas));
            cold.dispose?.();
          }

          for (let i = 0; i < order.length; i++) {
            if (warmHashes[i] !== coldHashes[i]) result.divergentFrames.push(order[i]!);
          }
          result.distinctWarmFrames = new Set(warmHashes).size;
          result.distinctColdFrames = new Set(coldHashes).size;
        } catch (error) {
          result.error = String(error);
        }
        return result;
      };

      return [
        // The exact shipped-freeze shape: a fanned-out MediaIn on LIVE media.
        runScenario("live-source-fanout", fanoutComp("gate1"), { animateSource: true }),
        // A static source must still be correct AND must actually reuse (else the cache is pointless).
        runScenario("static-source-reuse", fanoutComp("gate2"), { animateSource: false }),
        // A per-frame-varying materialized node: correctness + the memory bound.
        runScenario("time-varying-budget", timeVaryingComp("gate3"), {
          animateSource: true,
          materializeIds: ["gate3_flt"],
        }),
        // SCRUB: the same frames requested in DECREASING order. Playback is monotonic, scrubbing is not,
        // and a cache that keys on anything order-dependent (a cursor, a "last frame" assumption) is
        // correct forward and wrong backward — a class the forward-only scenarios above cannot see.
        runScenario("backward-scrub", fanoutComp("gate4"), { animateSource: true, reverse: true }),
        // AUTHORING CHURN: a node param edited every frame, i.e. dragging a slider. Every frame is a new
        // content hash, so this is both a correctness check (no stale artifact from the previous value)
        // and the memory check for the edit path — which allocated a render target per frame before the
        // retention policy landed.
        runScenario("param-edit-churn", timeVaryingComp("gate5"), {
          animateSource: false,
          materializeIds: ["gate5_flt"],
          editPerFrame: (c, frame) => {
            const node = (c as { nodes: Record<string, { params: Record<string, unknown> }> }).nodes["gate5_flt"]!;
            node.params = { ...node.params, effectParams: JSON.stringify({ amount: frame }) };
            (c as { version?: number }).version = frame + 1;
          },
        }),
        // EVICTION UNDER PRESSURE. Every other scenario stays comfortably under the 96MB budget, so the
        // retention policy never actually ran in the real GL path — only in its unit test. Squeeze the
        // budget to ~2 artifacts and the sweep must BOTH evict and stay pixel-correct: eviction is only
        // safe if a discarded artifact is genuinely re-renderable, and correctness here is what proves it.
        runScenario("eviction-under-pressure", timeVaryingComp("gate6"), {
          animateSource: true,
          materializeIds: ["gate6_flt"],
          budgetBytes: width * height * 4 * 2,
        }),
      ];
    },
    {
      frames: FRAMES,
      width: W,
      height: H,
      mods: {
        compositor: fsSpecifier("packages/shared/src/color/scene-compositor.ts"),
        compile: fsSpecifier("packages/shared/src/flarex/compile-flarex.ts"),
        registry: fsSpecifier("packages/shared/src/flarex/registry.ts"),
        nodeDefs: fsSpecifier("packages/shared/src/flarex/node-defs.ts"),
        builtins: fsSpecifier("packages/shared/src/color/fragment-effects/builtins.ts"),
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

  for (const r of results) {
    console.log(`\n[${r.name}] frames=${FRAMES} hits=${r.hits} misses=${r.misses} promotions=${r.promotions} evictions=${r.evictions} bytes=${(r.peakBytes / 1048576).toFixed(1)}MB/${(r.budgetBytes / 1048576).toFixed(0)}MB distinct warm=${r.distinctWarmFrames} cold=${r.distinctColdFrames}`);
    if (r.error) {
      fail(`${r.name}: scenario threw — ${r.error}`);
      continue;
    }

    // (1) The core assertion: cached rendering must be indistinguishable from uncached rendering.
    if (r.divergentFrames.length > 0) {
      fail(`${r.name}: warm (cached) diverged from cold (uncached) on ${r.divergentFrames.length} frame(s): [${r.divergentFrames.slice(0, 8).join(", ")}${r.divergentFrames.length > 8 ? ", …" : ""}] — a stale cache hit`);
    } else {
      ok(`${r.name}: every frame matches an uncached render (no stale hits)`);
    }

    // (2) The picture must actually MOVE when the input moves. This is the assertion that fails loudly
    //     on the original bug: a frozen clip renders one distinct frame while cold renders many.
    if (r.distinctColdFrames > 1 && r.distinctWarmFrames <= 1) {
      fail(`${r.name}: warm sweep produced ONE distinct frame while cold produced ${r.distinctColdFrames} — the picture is frozen`);
    } else if (r.distinctColdFrames > 1) {
      ok(`${r.name}: picture advances across the sweep (${r.distinctWarmFrames} distinct frames)`);
    }

    // (3) Memory must stay bounded. Pre-3c-B this grew ~8MB/frame without limit.
    if (r.budgetBytes > 0 && r.peakBytes > r.budgetBytes) {
      fail(`${r.name}: cache holds ${(r.peakBytes / 1048576).toFixed(1)}MB, over its ${(r.budgetBytes / 1048576).toFixed(0)}MB budget`);
    } else {
      ok(`${r.name}: cache stays within its GPU budget`);
    }
  }

  // (4) Eviction must actually have run somewhere, or the retention policy is only ever exercised by its
  //     unit test and could rot in the real GL path unnoticed.
  const squeezed = results.find((r) => r.name === "eviction-under-pressure");
  if (squeezed && !squeezed.error) {
    if (squeezed.evictions <= 0) {
      fail(`eviction-under-pressure: budget was squeezed to ~2 artifacts but nothing was evicted — the retention policy did not run`);
    } else {
      ok(`eviction-under-pressure: retention ran (${squeezed.evictions} evictions) and stayed pixel-correct`);
    }
  }

  // (5) The cache must EARN its memory: a static comp has to actually reuse artifacts, or it is pure
  //     overhead that happens to be parity-clean.
  const staticRun = results.find((r) => r.name === "static-source-reuse");
  if (staticRun && !staticRun.error) {
    if (staticRun.hits <= 0) {
      fail(`static-source-reuse: zero cache hits across ${FRAMES} frames — the cache is not reusing anything`);
    } else {
      ok(`static-source-reuse: cache actually reuses artifacts (${staticRun.hits} hits)`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nflarex content-cache sequence gate: all checks passed");
}

void main();
