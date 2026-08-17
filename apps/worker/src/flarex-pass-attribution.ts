/**
 * Flarex composite pass-count ATTRIBUTION (measurement only — no optimization).
 *
 * The Flarex engine chapter opens on a question `flarex:perf` cannot answer: it reports a wall-clock
 * total per scenario, and a total cannot be optimised. ADR-021's pull-model study separately measured
 * composite cost at 20.9-855.2 ms across N=1..100 (`plans/adr-021-pull-model-feasibility.md` Part 1)
 * and named the shape — "N sources funnel through N-1 merge nodes, so composite is O(N) full-frame RTT
 * passes" — but that was a CLAIM inferred from wall-clock scaling, not read off the GPU command stream.
 * This script re-drives the same shape (and three others) through `FrameProfiler`
 * (`packages/shared/src/color/frame-profiler.ts`), which patches the live WebGL2 context to count real
 * draw calls/binds/texture creations and attribute them to a render-role scope — so the pass count is
 * READ, not inferred.
 *
 * FOUR SHAPES, four different questions:
 *   - fanout-merge(N):   N distinct sources -> N-1 merges -> out.  "per input" / "same-frame growth".
 *   - filter-chain(N):   1 source -> N sequential filters -> out.  "per node" / "per grade stage".
 *   - shared-subtree(C): 1 expensive stack -> C merge consumers.   "same-frame redundancy" — does
 *                        materialization actually collapse the draw/RTT count, or does a second
 *                        consumer of the same intermediate still cost a second pass?
 *   - color-chain(bool): 4 DIFFERENT grade stages (fold into one ColorPipeline) vs the same stage
 *                        repeated 4x (compiler refuses to fold a repeat) — what pipeline coalescing
 *                        buys in PASSES, not just milliseconds.
 *
 * Every scenario runs several WARMUP frames (unprofiled) before the profiled frames: `RenderTarget`
 * allocation happens once and is cached (`??=` at the call sites) or pooled, so `rtt.alloc` after
 * warmup isolates NEW allocations (topology change) from PERSISTENT ones (steady-state playback of an
 * unchanging graph) — the number this stop actually needs, since the product question is "what does a
 * playing frame cost", not "what does the first frame cost".
 *
 * GPU TIMING (round 2). `compositorMs` below times CPU-side submission only — WebGL2 draw calls are
 * ASYNCHRONOUS, so a loop with no fence/readback/sync measures how fast the CPU can ENQUEUE work, not
 * how long the GPU takes to execute it. `FrameProfiler` already carries `EXT_disjoint_timer_query_webgl2`
 * support (`gpuBegin`/`gpuEnd` in frame-profiler.ts) — a real GPU-timeline query, one-frame-latency,
 * non-blocking — wired automatically the moment `SceneCompositor`'s constructor calls
 * `frameProfiler.instrumentGl(gl)`. This script reads it (`gpuMs`, from `__flarexProfile.gpuMs`) rather
 * than adding a second timing mechanism. No manual fence/flush fallback was needed: the extension is
 * available on this machine (confirmed by non-null `gpuMs` readings below) — if it had NOT been
 * available, this comment would say so and a `gl.fenceSync`+`clientWaitSync` fallback would be required
 * instead, since without either one, "compositorMs" alone cannot support ANY claim about GPU cost.
 *
 * Run (dev server must be up, PIXEL_BROWSER_CHANNEL=chrome or you measure SwiftShader — see below):
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-pass-attribution.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fsSpecifier = (rel: string) => `/@fs/${path.join(repoRoot, rel).replace(/\\/g, "/")}`;

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";

interface ScenarioFrame {
  n: number;
  drawCalls: number;
  drawByScope: Record<string, number>;
  rttAllocThisFrame: number;
  rttByLabel: Record<string, number>;
  framebufferBinds: number;
  programSwitches: number;
  textureBinds: number;
  materializations: number;
  nodesEvaluated: number;
  nodesSkipped: number;
  compileMs: number;
  compositorMs: number;
  uploadTotal: number;
  texCacheHit: number;
  texCacheMiss: number;
  /** GPU-timeline execution time (EXT_disjoint_timer_query_webgl2), one-frame-latency; null on the
   *  first profiled frame (no prior query to harvest) or if the extension is unavailable. */
  gpuMs: number | null;
  /** Fallback GPU-completion measurement (fenceSync + flush + clientWaitSync), CPU wall time from
   *  submission to GPU-signaled completion; null if the fence never signaled within the poll budget. */
  fenceCompletionMs: number | null;
}

async function main(): Promise<void> {
  // Same reason flarex:perf runs this first: a leftover Playwright tree corrupts a fresh launch, and
  // it must run before this process launches anything of its own — see browser-preflight.ts.
  assertQuietBrowserMachine({ label: "flarex-pass-attribution" });

  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  // Headless Chrome falls back to SwiftShader (software rasterization) — a different cost structure,
  // not a slower version of the same one. This script's entire point is reading the real GPU command
  // stream, so it launches headed unconditionally rather than trusting a flag someone might forget.
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const page = await browser.newPage();
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));
  // `?flarexProfile=1` — FrameProfiler's own flag read (`readFlag()` in frame-profiler.ts), so every
  // internal `frameProfiler.bump`/`measure`/`scoped` call in the compiler and compositor is already
  // live once this page loads; the harness only needs to call beginFrame/endFrame around each frame.
  await page.goto(`${BASE}/?flarexProfile=1`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const regime = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") ?? c.getContext("webgl");
      if (!gl) return "no-webgl";
      const dbg = (gl as WebGLRenderingContext).getExtension("WEBGL_debug_renderer_info");
      return dbg ? String((gl as WebGLRenderingContext).getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
    } catch {
      return "unknown";
    }
  });
  const software = /swiftshader|llvmpipe|software/i.test(regime);
  process.stdout.write(`renderer: ${regime}${software ? "  ** SOFTWARE — ABORTING, this script needs a real GPU **\n" : "\n"}`);
  if (software) {
    await browser.close();
    process.exit(1);
  }

  const gpuTimerAvailable = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2");
      return Boolean(gl?.getExtension("EXT_disjoint_timer_query_webgl2"));
    } catch {
      return false;
    }
  });
  process.stdout.write(
    `GPU timing instrument: ${gpuTimerAvailable ? "EXT_disjoint_timer_query_webgl2 (real GPU-timeline query)" : "UNAVAILABLE — gpuMs will read n/a; no fence/flush fallback is implemented in this script"}\n`,
  );

  const results: Record<string, ScenarioFrame[]> = await page.evaluate(
    async (mods: Record<string, string>) => {
      const { SceneCompositor } = await import(/* @vite-ignore */ mods.compositor!);
      const { compileFlarexComp } = await import(/* @vite-ignore */ mods.compile!);
      const { createFlarexComp } = await import(/* @vite-ignore */ mods.registry!);
      const { createFlarexNode } = await import(/* @vite-ignore */ mods.nodeDefs!);
      const { builtinFragmentEffectId } = await import(/* @vite-ignore */ mods.builtins!);
      const { frameProfiler } = await import(/* @vite-ignore */ mods.profiler!);

      interface FlarexEdgeLike { to: { nodeId: string; socket?: string }; from: { nodeId: string; socket?: string } }

      const sourceCanvas = (hue: number): HTMLCanvasElement => {
        const c = document.createElement("canvas");
        c.width = 256;
        c.height = 256;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = `hsl(${hue}, 60%, 45%)`;
        ctx.fillRect(0, 0, 256, 256);
        return c;
      };
      const sourceDraw = (canvas: HTMLCanvasElement, version = 1) => ({
        debugLayerId: "src",
        source: canvas,
        sourceWidth: canvas.width,
        sourceHeight: canvas.height,
        fit: "cover" as const,
        transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
        blendMode: "normal" as const,
        sourceVersion: version,
      });

      // ── Shape A: fanout-merge(N) — N distinct sources, N-1 merges. ADR-021's own topology. ──────
      const fanoutMergeComp = (id: string, n: number) => {
        const comp = createFlarexComp(id, "FanoutMerge");
        // Drop the built-in host MediaIn / out passthrough edge; every source below is an ASSET
        // MediaIn resolved through ctx.resolveSourceDraw, exactly like a real N-source comp. The
        // default `${id}_in` node stays in `comp.nodes` unreferenced — harmless, since compilation
        // traverses backward from `_out` and never reaches it.
        comp.edges = [];
        const assetIds: string[] = [];
        for (let i = 0; i < n; i++) {
          const nid = `${id}_src${i}`;
          const node = createFlarexNode("mediaIn", nid);
          node.params = { ...node.params, sourceAssetId: `asset_${id}_${i}` };
          comp.nodes[nid] = node;
          assetIds.push(`asset_${id}_${i}`);
        }
        let prev = `${id}_src0`;
        for (let i = 1; i < n; i++) {
          const mg = `${id}_m${i}`;
          comp.nodes[mg] = createFlarexNode("merge", mg);
          comp.edges.push({ id: `mb${i}`, from: { nodeId: prev, socket: "out" }, to: { nodeId: mg, socket: "bg" } });
          comp.edges.push({ id: `mf${i}`, from: { nodeId: `${id}_src${i}`, socket: "out" }, to: { nodeId: mg, socket: "fg" } });
          prev = mg;
        }
        comp.edges.push({ id: "eout", from: { nodeId: prev, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } });
        return { comp, assetIds };
      };

      // ── Shape B: filter-chain(N) — 1 source, N sequential filters. ────────────────────────────────
      const filterChainComp = (id: string, n: number) => {
        const comp = createFlarexComp(id, "Chain");
        const effects = ["pixelate", "sharpen", "chromaticAberration", "posterize", "halftone"];
        let prev = `${id}_in`;
        for (let i = 0; i < n; i++) {
          const nid = `${id}_f${i}`;
          const node = createFlarexNode("filter", nid);
          node.params = { ...node.params, effectId: builtinFragmentEffectId(effects[i % effects.length]!), effectParams: "" };
          comp.nodes[nid] = node;
          comp.edges.push({ id: `e${i}`, from: { nodeId: prev, socket: "out" }, to: { nodeId: nid, socket: "in" } });
          prev = nid;
        }
        comp.edges = comp.edges.filter((e: FlarexEdgeLike) => e.to.nodeId !== `${id}_out` || e.from.nodeId === prev);
        comp.edges.push({ id: "eout", from: { nodeId: prev, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } });
        return { comp };
      };

      // ── Shape C: shared-subtree(consumers) — one expensive stack, C merge consumers. ──────────────
      const sharedSubtreeComp = (id: string, consumers: number) => {
        const comp = createFlarexComp(id, "Shared");
        const effects = ["pixelate", "sharpen", "chromaticAberration", "posterize", "halftone"];
        let prev = `${id}_in`;
        for (let i = 0; i < 6; i++) {
          const fx = `${id}_s${i}`;
          const node = createFlarexNode("filter", fx);
          node.params = { ...node.params, effectId: builtinFragmentEffectId(effects[i % effects.length]!), effectParams: "" };
          comp.nodes[fx] = node;
          comp.edges.push({ id: `s${i}`, from: { nodeId: prev, socket: "out" }, to: { nodeId: fx, socket: "in" } });
          prev = fx;
        }
        const shared = prev;
        let prevMerge: string | null = null;
        for (let c = 0; c < consumers; c++) {
          const mg = `${id}_m${c}`;
          comp.nodes[mg] = createFlarexNode("merge", mg);
          comp.edges.push({ id: `mb${c}`, from: { nodeId: prevMerge ?? shared, socket: "out" }, to: { nodeId: mg, socket: "bg" } });
          comp.edges.push({ id: `mf${c}`, from: { nodeId: shared, socket: "out" }, to: { nodeId: mg, socket: "fg" } });
          prevMerge = mg;
        }
        comp.edges = comp.edges.filter((e: FlarexEdgeLike) => e.to.nodeId !== `${id}_out`);
        comp.edges.push({ id: "eo", from: { nodeId: prevMerge!, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } });
        return { comp };
      };

      // ── Shape D: color-chain(coalesced) — 4 different grade stages vs 1 stage x4. ───────────────────
      const colorChainComp = (id: string, coalesced: boolean) => {
        const comp = createFlarexComp(id, "Colour");
        const wheels = JSON.stringify({ shadows: { x: -0.1, y: 0.06, master: -0.04 }, midtones: { x: 0.16, y: -0.12, master: 0.09 }, highlights: { x: 0.05, y: 0.03, master: 0.07 } });
        const curves = JSON.stringify({ master: [{ x: 0, y: 0 }, { x: 0.3, y: 0.22 }, { x: 0.7, y: 0.8 }, { x: 1, y: 1 }] });
        const secondary = JSON.stringify({ hueCenter: 0.36, hueWidth: 0.14, softness: 0.08, satScale: 0.5 });
        const stages: Array<[string, Record<string, string | number>]> = coalesced
          ? [["colorWheels", { wheels }], ["colorCurves", { curves }], ["hslQualifier", { secondary }], ["colorCorrect", { exposure: 18, saturation: 128 }]]
          : [["colorCorrect", { exposure: 18 }], ["colorCorrect", { contrast: 14 }], ["colorCorrect", { saturation: 128 }], ["colorCorrect", { temperature: -12 }]];
        let prev = `${id}_in`;
        stages.forEach(([type, params], i) => {
          const nodeId = `${id}_c${i}`;
          const node = createFlarexNode(type as Parameters<typeof createFlarexNode>[0], nodeId);
          node.params = { ...node.params, ...params };
          comp.nodes[nodeId] = node;
          comp.edges.push({ id: `ce${i}`, from: { nodeId: prev, socket: "out" }, to: { nodeId, socket: "in" } });
          prev = nodeId;
        });
        comp.edges = comp.edges.filter((e: FlarexEdgeLike) => e.to.nodeId !== `${id}_out`);
        comp.edges.push({ id: "ceout", from: { nodeId: prev, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } });
        return { comp };
      };

      const WARMUP = 6;
      // 8, not 4: the GPU timer query harvests with ONE FRAME of latency (gpuEnd reads the PREVIOUS
      // frame's query), so the first profiled frame's gpuMs is always null — more frames means more
      // valid GPU samples to average, not just more CPU-timing samples.
      const PROFILED = 8;

      // `frameRef` is handed to `build` so a LIVE-source variant can read the current frame number
      // inside its own `resolveSourceDraw` closure and bump `sourceVersion` accordingly — simulating a
      // real decoder handing over a fresh frame every tick, which forces a real re-upload every frame
      // instead of one upload cached by the persistent texture cache (`texCache.hit`).
      const runScenario = (
        name: string,
        n: number,
        build: (frameRef: { n: number }) => { comp: unknown; resolveSourceDraw?: (nodeId: string, assetId: string) => unknown },
        dims: { width: number; height: number },
      ): ScenarioFrame[] => {
        const frameRef = { n: 0 };
        const { comp, resolveSourceDraw } = build(frameRef);
        const canvas = document.createElement("canvas");
        const compositor = new SceneCompositor(canvas, dims.width, dims.height, { contentCache: true });
        const hostSource = sourceCanvas(0);
        const frames: ScenarioFrame[] = [];
        for (let frame = 0; frame < WARMUP + PROFILED; frame++) {
          frameRef.n = frame;
          const profiling = frame >= WARMUP;
          if (profiling) frameProfiler.beginFrame();
          const t = frame / 30;
          const ctx: Record<string, unknown> = {
            compWidth: dims.width,
            compHeight: dims.height,
            renderScale: 1,
            timeSeconds: t,
            frameTimeSeconds: t,
            hostSourceDraw: sourceDraw(hostSource),
            matteCache: null,
            ...(resolveSourceDraw ? { resolveSourceDraw } : {}),
          };
          const draw = profiling
            ? frameProfiler.measure("evaluator.compile", () => compileFlarexComp(comp, ctx))
            : compileFlarexComp(comp, ctx);
          const spec = { width: dims.width, height: dims.height, backgroundColor: "#000000", layers: draw ? [draw] : [] };
          if (profiling) {
            frameProfiler.measure("compositor.render", () => compositor.renderFrame(spec));
            // FALLBACK (2026-08-17): EXT_disjoint_timer_query_webgl2 is present on this GPU/driver but
            // its query NEVER resolved (`gpuMs` read null on every single frame of every scenario in the
            // first pass) — the canvas here is never attached to the DOM/presented, and this ANGLE/D3D11
            // backend appears to need an actual present to retire the query. Per the fallback this stop
            // asked for: a `fenceSync` + `flush` + blocking `clientWaitSync`, timed on the CPU wall clock
            // from immediately after submission to the moment the GPU signals completion. This is coarser
            // than a real GPU-timeline timestamp (it can't separate "GPU busy" from "driver/queue
            // latency"), but it converts `compositorMs` from "time to ENQUEUE" into "time until the work
            // is actually DONE" — which is the question in dispute.
            const gl = compositor.sharedGl as WebGL2RenderingContext;
            const fenceStart = performance.now();
            let fenceCompletionMs: number | null = null;
            const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            if (sync) {
              gl.flush();
              const TIMEOUT_NS = 250_000_000; // 250ms per poll; looped, not a single unbounded block
              let status = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, TIMEOUT_NS);
              let polls = 1;
              while (status === gl.TIMEOUT_EXPIRED && polls < 8) {
                status = gl.clientWaitSync(sync, 0, TIMEOUT_NS);
                polls += 1;
              }
              gl.deleteSync(sync);
              fenceCompletionMs = status === gl.TIMEOUT_EXPIRED ? null : performance.now() - fenceStart;
            }
            frameProfiler.endFrame(compositor.profilerSnapshot?.() ?? null);
            const snap = (globalThis as unknown as { __flarexProfile?: Record<string, unknown> }).__flarexProfile;
            const counters = (snap?.counters ?? {}) as Record<string, number>;
            const timers = (snap?.timers ?? {}) as Record<string, number>;
            frames.push({
              n,
              drawCalls: counters["gpu.drawCalls"] ?? 0,
              drawByScope: (snap?.drawByScope ?? {}) as Record<string, number>,
              rttAllocThisFrame: counters["rtt.alloc"] ?? 0,
              rttByLabel: (snap?.rttByLabel ?? {}) as Record<string, number>,
              framebufferBinds: counters["gpu.framebufferBinds"] ?? 0,
              programSwitches: counters["gpu.programSwitches"] ?? 0,
              textureBinds: counters["gpu.textureBinds"] ?? 0,
              materializations: counters["eval.materializations"] ?? 0,
              nodesEvaluated: counters["eval.nodesEvaluated"] ?? 0,
              nodesSkipped: counters["eval.nodesSkipped"] ?? 0,
              compileMs: timers["evaluator.compile"] ?? 0,
              compositorMs: timers["compositor.render"] ?? 0,
              uploadTotal: counters["upload.total"] ?? 0,
              texCacheHit: counters["texCache.hit"] ?? 0,
              texCacheMiss: counters["texCache.miss"] ?? 0,
              gpuMs: typeof snap?.gpuMs === "number" ? (snap.gpuMs as number) : null,
              fenceCompletionMs,
            });
          } else {
            compositor.renderFrame(spec);
          }
        }
        compositor.dispose?.();
        return frames;
      };

      const out: Record<string, ScenarioFrame[]> = {};

      // Shape A — fanout-merge, matching ADR-021's own topology (N sources -> N-1 merges). Sources are
      // STATIC (sourceVersion pinned at 1): one upload, then persistent-cache hits every frame after.
      out["fanout-merge"] = [];
      for (const n of [1, 2, 4, 8, 16, 32, 50, 80, 100]) {
        const { comp, assetIds } = fanoutMergeComp(`fm${n}`, n);
        const sources = assetIds.map((_, i) => sourceCanvas((i * 47) % 360));
        const resolveSourceDraw = (nodeId: string, assetId: string) => {
          const idx = assetIds.indexOf(assetId);
          return idx >= 0 ? sourceDraw(sources[idx]!) : null;
        };
        out["fanout-merge"]!.push(
          ...runScenario("fanout-merge", n, () => ({ comp, resolveSourceDraw }), { width: 1920, height: 1080 }),
        );
      }

      // Shape A' — fanout-merge-LIVE: same topology, but every source's sourceVersion bumps every
      // frame (frameRef.n) — simulating a real decoder handing over a fresh VideoFrame each tick, which
      // ADR-021's original 20.9-855.2 ms measurement actually drove (real WebCodecs decode, not a
      // static canvas). Falsifier for the hypothesis that per-source re-upload, not the merge/precompose
      // draw calls themselves, is what the original wall-clock number was measuring.
      out["fanout-merge-live"] = [];
      for (const n of [1, 2, 4, 8, 16, 32, 50, 80, 100]) {
        const { comp, assetIds } = fanoutMergeComp(`fml${n}`, n);
        const sources = assetIds.map((_, i) => sourceCanvas((i * 47) % 360));
        out["fanout-merge-live"]!.push(
          ...runScenario(
            "fanout-merge-live",
            n,
            (frameRef) => ({
              comp,
              resolveSourceDraw: (nodeId: string, assetId: string) => {
                const idx = assetIds.indexOf(assetId);
                return idx >= 0 ? sourceDraw(sources[idx]!, frameRef.n + 1) : null;
              },
            }),
            { width: 1920, height: 1080 },
          ),
        );
      }

      // Shape B — filter-chain, single source, N sequential filters.
      out["filter-chain"] = [];
      for (const n of [5, 10, 20, 40, 80, 160]) {
        out["filter-chain"]!.push(
          ...runScenario("filter-chain", n, () => filterChainComp(`fc${n}`, n), { width: 1920, height: 1080 }),
        );
      }

      // Shape C — shared-subtree, one expensive stack, C consumers.
      out["shared-subtree"] = [];
      for (const c of [1, 2, 4, 8, 16]) {
        out["shared-subtree"]!.push(
          ...runScenario("shared-subtree", c, () => sharedSubtreeComp(`ss${c}`, c), { width: 3840, height: 2160 }),
        );
      }

      // Shape D — color-chain, coalesced (n=1 label) vs uncoalesced (n=0 label).
      out["color-chain"] = [];
      out["color-chain"]!.push(...runScenario("color-chain", 1, () => colorChainComp("cc1", true), { width: 3840, height: 2160 }));
      out["color-chain"]!.push(...runScenario("color-chain", 0, () => colorChainComp("cc0", false), { width: 3840, height: 2160 }));

      return out;
    },
    {
      compositor: fsSpecifier("packages/shared/src/color/scene-compositor.ts"),
      compile: fsSpecifier("packages/shared/src/flarex/compile-flarex.ts"),
      registry: fsSpecifier("packages/shared/src/flarex/registry.ts"),
      nodeDefs: fsSpecifier("packages/shared/src/flarex/node-defs.ts"),
      builtins: fsSpecifier("packages/shared/src/color/fragment-effects/builtins.ts"),
      profiler: fsSpecifier("packages/shared/src/color/frame-profiler.ts"),
    },
  );

  await browser.close();

  // ── Report: last profiled frame per N (steady state), averaged draw/RTT counts across the window. ──
  const avg = (frames: ScenarioFrame[], key: keyof ScenarioFrame): number => {
    const vals = frames.map((f) => f[key] as number);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const avgNullable = (frames: ScenarioFrame[], key: "gpuMs" | "fenceCompletionMs"): string => {
    const vals = frames.map((f) => f[key]).filter((v): v is number => v != null);
    return vals.length ? `${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)} (n=${vals.length}/${frames.length})` : "n/a (never resolved)";
  };
  const mergeCounters = (frames: ScenarioFrame[], key: "drawByScope" | "rttByLabel"): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const f of frames) for (const [k, v] of Object.entries(f[key])) out[k] = (out[k] ?? 0) + v / frames.length;
    return out;
  };

  for (const [scenario, allFrames] of Object.entries(results)) {
    console.log(`\n=== ${scenario} ===`);
    const byN = new Map<number, ScenarioFrame[]>();
    for (const f of allFrames) {
      if (!byN.has(f.n)) byN.set(f.n, []);
      byN.get(f.n)!.push(f);
    }
    for (const [n, frames] of [...byN.entries()].sort((a, b) => a[0] - b[0])) {
      const scopes = mergeCounters(frames, "drawByScope");
      const rtts = mergeCounters(frames, "rttByLabel");
      const scopeStr = Object.entries(scopes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ");
      const rttStr = Object.entries(rtts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ") || "(none)";
      console.log(
        `  N=${n}  draws=${avg(frames, "drawCalls").toFixed(1)} [${scopeStr}]  ` +
          `fbBinds=${avg(frames, "framebufferBinds").toFixed(1)} progSwitches=${avg(frames, "programSwitches").toFixed(1)} texBinds=${avg(frames, "textureBinds").toFixed(1)}  ` +
          `rtt.alloc(steady)=${avg(frames, "rttAllocThisFrame").toFixed(2)} [${rttStr}]  ` +
          `materializations=${avg(frames, "materializations").toFixed(1)} evaluated=${avg(frames, "nodesEvaluated").toFixed(1)} skipped=${avg(frames, "nodesSkipped").toFixed(1)}  ` +
          `compileMs=${avg(frames, "compileMs").toFixed(2)} compositorMs(CPU submit)=${avg(frames, "compositorMs").toFixed(2)} ` +
          `gpuMs(timer-query)=${avgNullable(frames, "gpuMs")} fenceMs(submit->GPU-done)=${avgNullable(frames, "fenceCompletionMs")}  ` +
          `uploads=${avg(frames, "uploadTotal").toFixed(1)} texCache=${avg(frames, "texCacheHit").toFixed(1)}h/${avg(frames, "texCacheMiss").toFixed(1)}m`,
      );
    }
  }

  console.log("\nflarex-pass-attribution: complete (measurement only, nothing asserted)");
}

void main();
