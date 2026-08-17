/**
 * DEBT-032, bounded final stop. Three deterministic falsifiers (request ordering, GL-interleaving,
 * eviction/hard-reset) came back clean, and the entry's own re-runs showed the decode/upload split
 * itself was not stable run-to-run. Before hunting a fourth mechanism — explicitly ruled out this stop
 * — settle the prior question: IS THERE A PHENOMENON AT ALL? Same topology (N=1, 10, 20, 30), repeated
 * up to 10 times, same machine, one browser session (to hold machine state as constant as a repeat
 * measurement can), recording the decode/upload+composite split and the total every time.
 *
 * "Elevated" is defined relative to N=10 rather than an absolute number, since the absolute total
 * varies run to run (see DEBT-032's addendum): total(N=30) / total(N=10) > 3.5 (a comp of 3x the
 * layers costing more than 3.5x is super-linear beyond simple layer-count scaling) marks a run as
 * showing the N=30 elevation; same test at N=20 / N=10 > 2.5.
 *
 * This is the LAST measurement this chapter authorizes for the slowdown question — the number gets
 * written down, not chased further regardless of the answer.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-debt032-distribution-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fsSpecifier = (rel: string) => `/@fs/${path.join(repoRoot, rel).replace(/\\/g, "/")}`;
const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";
const N_LADDER = [1, 10, 20, 30];
const REPEATS = 10;
const WARMUP_STEPS = 2;
const MEASURED_STEPS = 4; // trimmed from 6 -- 10 reps x 4 N x N providers is already a lot of real decode

function seedClips(count: number): string[] {
  const dir = path.join(repoRoot, "apps/api/storage/finals");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  if (files.length < count) throw new Error(`need ${count} distinct clips, found ${files.length}`);
  return files.slice(0, count);
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex-debt032-distribution-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const page = await browser.newPage();
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  const maxNeeded = Math.max(...N_LADDER);
  const clipPaths = seedClips(maxNeeded);
  await page.route("**/__local-clip__/*", async (route) => {
    const idx = Number(new URL(route.request().url()).pathname.split("/").pop());
    const filePath = clipPaths[idx];
    if (filePath == null) return route.fulfill({ status: 404, body: "not found" });
    const body = fs.readFileSync(filePath);
    return route.fulfill({ status: 200, contentType: "video/mp4", body });
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
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
  process.stdout.write(`renderer: ${regime}${software ? "  ** SOFTWARE — ABORTING **\n" : "\n"}\n`);
  if (software) {
    await browser.close();
    process.exit(1);
  }
  console.log(`plan: ${REPEATS} repeats x N=${N_LADDER.join(",")}, ${WARMUP_STEPS} warmup + ${MEASURED_STEPS} measured frames/N\n`);

  const results: { repeat: number; n: number; decodeMs: number; restMs: number; totalMs: number }[] = await page.evaluate(
    async (payload: { mods: Record<string, string>; nLadder: number[]; repeats: number; warmupSteps: number; measuredSteps: number }) => {
      const { nLadder, repeats, warmupSteps, measuredSteps } = payload;
      const { SceneFrameCompositor } = await import(/* @vite-ignore */ payload.mods.compositor!);
      const { createFrameProvider, clipSourceKey } = await import(/* @vite-ignore */ payload.mods.sourceDecoder!);

      type TL = Record<string, unknown>;
      const buildComposition = (n: number, width: number, height: number) => {
        const layerIds: string[] = [];
        const assetIds: string[] = [];
        const tracks = [];
        for (let i = 0; i < n; i++) {
          const layerId = `layer_${i}`;
          const assetId = `asset_${i}`;
          layerIds.push(layerId);
          assetIds.push(assetId);
          tracks.push({
            id: `track_${i}`,
            type: "video",
            name: `Track ${i}`,
            layers: [
              {
                id: layerId,
                trackId: `track_${i}`,
                type: "video",
                assetId,
                startSeconds: 0,
                durationSeconds: 10,
                fit: "cover",
                transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
                effects: [],
                keyframes: [],
              },
            ],
          });
        }
        return {
          composition: { id: "dist_probe", name: "Dist", width, height, fps: 30, durationSeconds: 10, backgroundColor: "#000000", tracks } as TL,
          layerIds,
          assetIds,
        };
      };

      const out: { repeat: number; n: number; decodeMs: number; restMs: number; totalMs: number }[] = [];

      for (let repeat = 0; repeat < repeats; repeat++) {
        for (const n of nLadder) {
          const width = 640;
          const height = 360;
          const { composition, layerIds, assetIds } = buildComposition(n, width, height);

          const providers = new Map<string, unknown>();
          let decodeMsThisFrame = 0;
          for (let i = 0; i < n; i++) {
            const url = `${location.origin}/__local-clip__/${i}`;
            const provider: any = await createFrameProvider(url, "video");
            const origGetFrame = provider.getFrame.bind(provider);
            provider.getFrame = async (t: number) => {
              const t0 = performance.now();
              const f = await origGetFrame(t);
              decodeMsThisFrame += performance.now() - t0;
              return f;
            };
            providers.set(clipSourceKey(layerIds[i]!, assetIds[i]!), provider);
          }
          const getSource = (key: string) => providers.get(key);

          const canvas = document.createElement("canvas");
          const compositor = new SceneFrameCompositor(composition, canvas, getSource, {});
          let decodeMs = 0;
          let totalMs = 0;
          for (let frame = 0; frame < warmupSteps + measuredSteps; frame++) {
            const t = frame / 30;
            decodeMsThisFrame = 0;
            const t0 = performance.now();
            await compositor.renderFrame(t);
            const dt = performance.now() - t0;
            if (frame >= warmupSteps) {
              decodeMs += decodeMsThisFrame;
              totalMs += dt;
            }
          }
          compositor.dispose?.();
          out.push({ repeat, n, decodeMs, restMs: totalMs - decodeMs, totalMs });
          for (const provider of providers.values()) (provider as { dispose?: () => void }).dispose?.();
        }
      }

      return out;
    },
    {
      mods: {
        compositor: fsSpecifier("apps/web/src/export/scene-frame-compositor.ts"),
        sourceDecoder: fsSpecifier("apps/web/src/export/source-decoder.ts"),
      },
      nLadder: N_LADDER,
      repeats: REPEATS,
      warmupSteps: WARMUP_STEPS,
      measuredSteps: MEASURED_STEPS,
    },
  );

  await browser.close();

  console.log("repeat |  N=1  total/dec/rest  |  N=10 total/dec/rest  |  N=20 total/dec/rest   |  N=30 total/dec/rest    | N20/N10 | N30/N10");
  const byRepeat = new Map<number, Map<number, { decodeMs: number; restMs: number; totalMs: number }>>();
  for (const row of results) {
    if (!byRepeat.has(row.repeat)) byRepeat.set(row.repeat, new Map());
    byRepeat.get(row.repeat)!.set(row.n, row);
  }
  let elevated20 = 0;
  let elevated30 = 0;
  const ratios20: number[] = [];
  const ratios30: number[] = [];
  for (let r = 0; r < REPEATS; r++) {
    const byN = byRepeat.get(r)!;
    const at = (n: number) => byN.get(n)!;
    const n1 = at(1);
    const n10 = at(10);
    const n20 = at(20);
    const n30 = at(30);
    const ratio20 = n20.totalMs / n10.totalMs;
    const ratio30 = n30.totalMs / n10.totalMs;
    ratios20.push(ratio20);
    ratios30.push(ratio30);
    if (ratio20 > 2.5) elevated20 += 1;
    if (ratio30 > 3.5) elevated30 += 1;
    const fmt = (v: { totalMs: number; decodeMs: number; restMs: number }) =>
      `${v.totalMs.toFixed(0).padStart(6)}/${v.decodeMs.toFixed(0).padStart(4)}/${v.restMs.toFixed(0).padStart(4)}`;
    console.log(
      `  ${String(r).padStart(4)} | ${fmt(n1)}         | ${fmt(n10)}         | ${fmt(n20)}          | ${fmt(n30)}           | ${ratio20.toFixed(2).padStart(6)} | ${ratio30.toFixed(2).padStart(6)}`
    );
  }

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };
  console.log(
    `\nN=20/N=10 ratio: mean=${avg(ratios20).toFixed(2)} median=${median(ratios20).toFixed(2)} min=${Math.min(...ratios20).toFixed(2)} max=${Math.max(...ratios20).toFixed(2)}`
  );
  console.log(
    `N=30/N=10 ratio: mean=${avg(ratios30).toFixed(2)} median=${median(ratios30).toFixed(2)} min=${Math.min(...ratios30).toFixed(2)} max=${Math.max(...ratios30).toFixed(2)}`
  );
  console.log(`\nN=20 elevated (ratio > 2.5) in ${elevated20}/${REPEATS} runs`);
  console.log(`N=30 elevated (ratio > 3.5) in ${elevated30}/${REPEATS} runs`);
  console.log(
    elevated20 >= REPEATS / 2 || elevated30 >= REPEATS / 2
      ? "\nMAJORITY of runs show elevation — DEBT-032 is a real, noisy phenomenon. Record the distribution, not a mechanism."
      : "\nMINORITY of runs show elevation — the earlier 'explosion' framing looks like an artefact of unrepeated measurement."
  );

  console.log("\nflarex-debt032-distribution-probe: complete (measurement only, nothing asserted)");
}

void main();
