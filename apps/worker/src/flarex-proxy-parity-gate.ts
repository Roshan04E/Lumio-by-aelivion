/**
 * Flarex comp-proxy SUBSTITUTION PARITY gate (plans/flarex-comp-proxy.md, S2).
 *
 * WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * The plan asked for the proxy to be "pixel-identical" to the live path. That is not achievable and
 * never was: a proxy is H.264, which is lossy, so a naive proxy-vs-live diff measures the ENCODER and
 * would drown the thing we actually care about. Two independent quantities got conflated:
 *
 *   (a) CODEC loss — how faithfully mp4/H.264 stores the comp output. Bounded, well understood, and
 *       tunable with bitrate; not a correctness property.
 *   (b) SUBSTITUTION error — whether PRESENTING a proxy frame produces the same picture as the comp
 *       it stands in for. This is the correctness property, and it is where the real bugs live: the
 *       flarex hook runs at the END of the layer's draw build, so the clip's transform, opacity,
 *       blend, blur and content transform are already baked into the proxy; a substituted draw that
 *       re-applies any of them is wrong in a way that is invisible on a centred, unrotated clip.
 *
 * This gate isolates (b) by feeding the LIVE COMPOSITE BACK IN as the proxy frame — i.e. a perfect,
 * loss-free proxy. Any difference is then attributable to the substitution path alone, so the
 * threshold can be tight instead of being slack enough to absorb codec noise.
 *
 * It is not circular: the oracle is the live comp rendered through `compileFlarexComp`, while the
 * comparison arm goes through a different code path — `applyFlarex`'s short-circuit, a freshly built
 * draw, and a separate texture upload. A geometry mistake shows up immediately (a double-applied
 * scale of 1.8 moves essentially every pixel).
 *
 * Run (dev server must be up):
 *   pnpm --filter @orreris/worker flarex:proxy-gate
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker flarex:proxy-gate
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fsSpecifier = (rel: string) => `/@fs/${path.join(repoRoot, rel).replace(/\\/g, "/")}`;

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";
const W = 320;
const H = 180;
/** Both arms composite the same texture through the same GL path; only sampling noise is expected. */
const MAX_DIFF_PERCENT = Number(process.env.FLAREX_PROXY_MAX_DIFF ?? 0.5);

interface ScenarioResult {
  name: string;
  diffPercent: number;
  maxChannelDelta: number;
  /** Distinct pixels in the LIVE render — guards against both arms being trivially blank. */
  liveNonBlank: boolean;
  error?: string;
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage();
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const results: ScenarioResult[] = await page.evaluate(
    async (payload: { width: number; height: number; mods: Record<string, string> }) => {
      const { width, height, mods } = payload;
      const { SceneCompositor } = await import(/* @vite-ignore */ mods.compositor!);
      const { buildSceneDraws } = await import(/* @vite-ignore */ mods.build!);
      const { createFlarexComp } = await import(/* @vite-ignore */ mods.registry!);
      const { createFlarexNode } = await import(/* @vite-ignore */ mods.nodeDefs!);
      const { builtinFragmentEffectId } = await import(/* @vite-ignore */ mods.builtins!);

      /** Media stand-in with structure in it — a flat fill would hide a geometry error. */
      const makeSource = (): HTMLCanvasElement => {
        const c = document.createElement("canvas");
        c.width = 128;
        c.height = 128;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#204060";
        ctx.fillRect(0, 0, 128, 128);
        for (let i = 0; i < 8; i += 1) {
          ctx.fillStyle = i % 2 ? "#e0b040" : "#40c090";
          ctx.fillRect(i * 16, 0, 8, 128);
          ctx.fillRect(0, i * 16, 128, 8);
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(4, 4, 20, 20); // corner marker: a flip/rotation is unmissable
        return c;
      };

      const readback = document.createElement("canvas");
      readback.width = width;
      readback.height = height;
      const readCtx = readback.getContext("2d", { willReadFrequently: true })!;
      // `Uint8ClampedArray<ArrayBuffer>`, not the bare alias. TypedArrays became generic over their
      // backing buffer, so `getImageData().data` now widens to `ArrayBufferLike` — which includes
      // `SharedArrayBuffer` — while the `ImageData` constructor accepts only `ArrayBuffer`. The widening
      // is a lib-side possibility, never a runtime one: `getImageData` cannot return shared-backed
      // pixels. Narrowing here rather than casting at the two call sites keeps the claim in one place,
      // beside the call that justifies it. Types only; no runtime change.
      const snapshot = (glCanvas: HTMLCanvasElement): Uint8ClampedArray<ArrayBuffer> => {
        readCtx.clearRect(0, 0, width, height);
        readCtx.drawImage(glCanvas, 0, 0, width, height);
        return readCtx.getImageData(0, 0, width, height).data;
      };

      const runScenario = (name: string, hostOverrides: Record<string, unknown>): ScenarioResult => {
        const result: ScenarioResult = { name, diffPercent: 0, maxChannelDelta: 0, liveNonBlank: false };
        try {
          const compId = `parity_${name}`;
          const comp = createFlarexComp(compId, name);
          // A filter so the comp genuinely TRANSFORMS its input: if the comp were a passthrough, a
          // substitution bug that drew the host media instead of the comp output would still pass.
          const fx = createFlarexNode("filter", `${compId}_fx`);
          fx.params = { ...fx.params, effectId: builtinFragmentEffectId("pixelate"), effectParams: "" };
          comp.nodes[`${compId}_fx`] = fx;
          comp.edges = [
            { id: "e1", from: { nodeId: `${compId}_in`, socket: "out" }, to: { nodeId: `${compId}_fx`, socket: "in" } },
            { id: "e2", from: { nodeId: `${compId}_fx`, socket: "out" }, to: { nodeId: `${compId}_out`, socket: "in" } },
          ];

          const source = makeSource();
          const layer = {
            id: "host",
            trackId: "t",
            type: "video",
            name: "host",
            startSeconds: 0,
            durationSeconds: 5,
            assetId: "a",
            fit: "fill",
            transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
            effects: [],
            keyframes: [],
            flarexCompId: compId,
            ...hostOverrides,
          };

          const common = {
            layers: [layer],
            width,
            height,
            currentTime: 1,
            renderScale: 1,
            transitions: [],
            rasterizer: null,
            matteCache: null,
            gradeRenderers: new Map(),
            getMediaGraded: () => source,
            createCanvas: () => document.createElement("canvas"),
            flarexComps: { [compId]: comp },
          };

          // ARM 1 — LIVE: the comp lowered and composited. The oracle.
          const liveCanvas = document.createElement("canvas");
          const live = new SceneCompositor(liveCanvas, width, height);
          live.renderFrame({ width, height, backgroundColor: "#000000", layers: buildSceneDraws(common) });
          const livePixels = snapshot(liveCanvas);
          live.dispose?.();

          // A blank oracle would make any comparison meaningless.
          result.liveNonBlank = livePixels.some((v, i) => i % 4 !== 3 && v > 8);

          // The live composite, captured as a PERFECT (loss-free) proxy frame.
          const proxyFrame = document.createElement("canvas");
          proxyFrame.width = width;
          proxyFrame.height = height;
          proxyFrame.getContext("2d")!.putImageData(new ImageData(livePixels, width, height), 0, 0);

          // ARM 2 — SUBSTITUTED: same layer, same compositor, but the comp is replaced by that frame.
          const proxyCanvas = document.createElement("canvas");
          const proxied = new SceneCompositor(proxyCanvas, width, height);
          proxied.renderFrame({
            width,
            height,
            backgroundColor: "#000000",
            layers: buildSceneDraws({
              ...common,
              flarexCompProxies: {
                [compId]: { source: proxyFrame, sourceWidth: width, sourceHeight: height, sourceVersion: 1 },
              },
            }),
          });
          const proxyPixels = snapshot(proxyCanvas);
          proxied.dispose?.();

          let differing = 0;
          let maxDelta = 0;
          const pixels = width * height;
          for (let i = 0; i < pixels; i += 1) {
            const o = i * 4;
            const dr = Math.abs(livePixels[o]! - proxyPixels[o]!);
            const dg = Math.abs(livePixels[o + 1]! - proxyPixels[o + 1]!);
            const db = Math.abs(livePixels[o + 2]! - proxyPixels[o + 2]!);
            const delta = Math.max(dr, dg, db);
            if (delta > 2) differing += 1; // >2/255 is a real difference, not dithering
            if (delta > maxDelta) maxDelta = delta;
          }
          result.diffPercent = (differing / pixels) * 100;
          result.maxChannelDelta = maxDelta;
        } catch (error) {
          result.error = String(error);
        }
        return result;
      };

      return [
        // Baseline: a plain centred clip. Even a badly broken substitution can pass here, which is
        // exactly why the cases below exist.
        runScenario("identity-host", {}),
        // The case that catches a double-applied transform. If the proxy draw inherited the host's
        // transform, the picture is scaled 1.6x and rotated again — a very large diff.
        runScenario("transformed-host", {
          transform: { position: { x: 38, y: 62 }, scale: 1.6, rotation: 18, opacity: 100 },
        }),
        // Opacity is baked in by the compositor when it composites the layer, so re-applying it
        // would darken the proxy against the background.
        runScenario("semi-transparent-host", {
          transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 45 },
        }),
        // A blur on the host is inside the comp's MediaIn; inheriting it blurs an already-blurred image.
        runScenario("blurred-host", {
          effects: [{ id: "e_blur", type: "blur", enabled: true, params: { amount: 35 } }],
        }),
      ];
    },
    {
      width: W,
      height: H,
      mods: {
        compositor: fsSpecifier("packages/shared/src/color/scene-compositor.ts"),
        build: fsSpecifier("packages/shared/src/scene/build-scene-draws.ts"),
        registry: fsSpecifier("packages/shared/src/flarex/registry.ts"),
        nodeDefs: fsSpecifier("packages/shared/src/flarex/node-defs.ts"),
        builtins: fsSpecifier("packages/shared/src/color/fragment-effects/builtins.ts"),
      },
    }
  );

  await browser.close();

  let failures = 0;
  for (const r of results) {
    console.log(`\n[${r.name}] diff=${r.diffPercent.toFixed(3)}%  maxChannelDelta=${r.maxChannelDelta}`);
    if (r.error) {
      failures += 1;
      console.error(`FAIL  ${r.name}: scenario threw — ${r.error}`);
      continue;
    }
    if (!r.liveNonBlank) {
      failures += 1;
      console.error(`FAIL  ${r.name}: the LIVE render is blank — the comparison would be vacuous`);
      continue;
    }
    if (r.diffPercent > MAX_DIFF_PERCENT) {
      failures += 1;
      console.error(
        `FAIL  ${r.name}: substituting the proxy changed ${r.diffPercent.toFixed(3)}% of pixels ` +
          `(limit ${MAX_DIFF_PERCENT}%). The proxy already contains the clip's transform/opacity/blur — ` +
          `a substituted draw must re-apply none of them.`
      );
    } else {
      console.log(`  ok  ${r.name}: substitution matches the live composite`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nflarex comp-proxy parity gate: all checks passed");
}

void main();
