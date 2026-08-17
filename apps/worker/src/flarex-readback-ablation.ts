/**
 * ADR-021 re-attribution — the READBACK ABLATION (measurement only — no optimization).
 *
 * `flarex-pass-attribution.ts` found that GPU-side completion (fenceSync + flush + clientWaitSync,
 * since EXT_disjoint_timer_query_webgl2 never resolved a single sample in that harness) stays flat at
 * ~0.1-0.2 ms even at N=100 sources with a fresh texture upload every frame. That falsifies "expensive
 * GPU execution" as the explanation for ADR-021's reported 20.9-855.2 ms composite cost
 * (`plans/adr-021-pull-model-feasibility.md` Part 1). The remaining hypothesis, raised explicitly this
 * round: that harness's own per-frame `luma` sanity check required a synchronous CPU pixel readback
 * (`getImageData`/`readPixels`), and a readback FORCES the GPU command queue to drain — turning an
 * otherwise-async submission loop into a de facto sync point, and inflating the measured "composite"
 * span with a stall that has nothing to do with compositing.
 *
 * This script tests that directly, on REAL WebCodecs sources (not synthetic canvases), through the REAL
 * `SceneFrameCompositor` export path — same class, same `gradeMediaLayer` → `source.getFrame()` pull,
 * same `stageProbe` readback mechanism ADR-021's harness almost certainly used for its own `luma`
 * column (`meanLumaFromRgba` / `getImageData` at scene-frame-compositor.ts:242-258, gated behind the
 * SAME opt-in `stageProbe` option this script toggles). Two arms, same N ladder, same everything else:
 *
 *   readback OFF : `stageProbe` omitted — the default production export path, no CPU readback ever.
 *   readback ON  : `stageProbe` supplied with `sampleTimes` covering every rendered frame, so
 *                  `gradeMediaLayer`'s per-layer "decode" stage probe (a real `getImageData` call) fires
 *                  on every layer, every frame — worst case, matching a diagnostic run that samples
 *                  everything rather than a sparse ladder.
 *
 * SCOPE NOTE, stated rather than hidden: this composition is N video layers STACKED on N tracks (plain
 * timeline, no Flarex node graph, no merge nodes) — not a byte-for-byte reproduction of ADR-021's
 * "N MediaIn nodes through N-1 merges" Flarex fixture, and the source files are real project exports
 * from `apps/api/storage/finals`, not the specific 1280x720 GOP-12 proxy recipe ADR-021 built. Both
 * still exercise the SAME cost centers under test — `gradeMediaLayer`'s real `source.getFrame()` pull,
 * real WebCodecs decode, real per-frame texture upload, and (when ON) the real readback call — which is
 * what the ablation needs. If N-source composite structure specifically (not the readback) still needs
 * re-measurement on the EXACT original fixture, that is a separate, smaller follow-up.
 *
 * Run (dev server must be up, PIXEL_BROWSER_CHANNEL=chrome or you measure SwiftShader):
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-readback-ablation.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fsSpecifier = (rel: string) => `/@fs/${path.join(repoRoot, rel).replace(/\\/g, "/")}`;
const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";
const N_LADDER = [1, 5, 10, 20, 30];
const FRAMES_PER_N = 6;

function seedClips(count: number): string[] {
  const dir = path.join(repoRoot, "apps/api/storage/finals");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size); // smallest first — faster decode setup
  if (files.length < count) throw new Error(`need ${count} distinct clips, found ${files.length} in ${dir}`);
  return files.slice(0, count);
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex-readback-ablation" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const page = await browser.newPage();
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  // Serve real local MP4 bytes at a stable URL the page can fetch — avoids inflating Playwright's
  // evaluate() argument channel with base64 video (§ a few hundred MB across N=30 clips).
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
  process.stdout.write(`renderer: ${regime}${software ? "  ** SOFTWARE — ABORTING **\n" : "\n"}`);
  if (software) {
    await browser.close();
    process.exit(1);
  }

  const results: Record<string, { n: number; readback: boolean; frameMs: number[] }[]> = await page.evaluate(
    async (payload: { mods: Record<string, string>; nLadder: number[]; framesPerN: number }) => {
      const { nLadder, framesPerN } = payload;
      const { SceneFrameCompositor } = await import(/* @vite-ignore */ payload.mods.compositor!);
      const { createFrameProvider, clipSourceKey } = await import(/* @vite-ignore */ payload.mods.sourceDecoder!);

      type TL = Record<string, unknown>;
      const buildComposition = (n: number, width: number, height: number): { composition: TL; layerIds: string[]; assetIds: string[] } => {
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
          composition: { id: "ablation_comp", name: "Ablation", width, height, fps: 30, durationSeconds: 10, backgroundColor: "#000000", tracks },
          layerIds,
          assetIds,
        };
      };

      const out: Record<string, { n: number; readback: boolean; frameMs: number[] }[]> = { readbackOFF: [], readbackON: [] };

      for (const n of nLadder) {
        const width = 640;
        const height = 360;
        const { composition, layerIds, assetIds } = buildComposition(n, width, height);

        const providers = new Map<string, unknown>();
        for (let i = 0; i < n; i++) {
          const url = `${location.origin}/__local-clip__/${i}`;
          const provider = await createFrameProvider(url, "video");
          providers.set(clipSourceKey(layerIds[i]!, assetIds[i]!), provider);
        }
        const getSource = (key: string) => providers.get(key);

        for (const readback of [false, true]) {
          const canvas = document.createElement("canvas");
          const sampleTimes = Array.from({ length: framesPerN + 2 }, (_, i) => i / 30);
          const options = readback
            ? {
                stageProbe: {
                  sampleTimes,
                  fps: 30,
                  onProbe: () => undefined, // the READBACK is the cost under test; the callback itself is a no-op
                },
              }
            : {};
          const compositor = new SceneFrameCompositor(composition, canvas, getSource, options);
          const frameMs: number[] = [];
          // 2 warmup frames (decoder priming, first-frame allocation), then measured frames.
          for (let frame = 0; frame < framesPerN + 2; frame++) {
            const t = frame / 30;
            const t0 = performance.now();
            await compositor.renderFrame(t);
            const dt = performance.now() - t0;
            if (frame >= 2) frameMs.push(dt);
          }
          compositor.dispose?.();
          out[readback ? "readbackON" : "readbackOFF"]!.push({ n, readback, frameMs });
        }

        for (const provider of providers.values()) (provider as { dispose?: () => void }).dispose?.();
      }

      return out;
    },
    {
      mods: {
        compositor: fsSpecifier("apps/web/src/export/scene-frame-compositor.ts"),
        sourceDecoder: fsSpecifier("apps/web/src/export/source-decoder.ts"),
      },
      nLadder: N_LADDER,
      framesPerN: FRAMES_PER_N,
    },
  );

  await browser.close();

  console.log("\n=== readback ablation (real WebCodecs sources, real SceneFrameCompositor) ===");
  const byN = new Map<number, { off?: number[]; on?: number[] }>();
  for (const row of results.readbackOFF ?? []) byN.set(row.n, { ...byN.get(row.n), off: row.frameMs });
  for (const row of results.readbackON ?? []) byN.set(row.n, { ...byN.get(row.n), on: row.frameMs });
  const avg = (xs: number[] | undefined) => (xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  for (const [n, { off, on }] of [...byN.entries()].sort((a, b) => a[0] - b[0])) {
    const offAvg = avg(off);
    const onAvg = avg(on);
    const delta = onAvg - offAvg;
    console.log(
      `  N=${n}  readback-OFF avg=${offAvg.toFixed(2)}ms [${(off ?? []).map((v) => v.toFixed(1)).join(",")}]  ` +
        `readback-ON avg=${onAvg.toFixed(2)}ms [${(on ?? []).map((v) => v.toFixed(1)).join(",")}]  ` +
        `delta=${delta >= 0 ? "+" : ""}${delta.toFixed(2)}ms (${offAvg > 0 ? ((delta / offAvg) * 100).toFixed(0) : "?"}%)`,
    );
  }
  console.log("\nflarex-readback-ablation: complete (measurement only, nothing asserted)");
}

void main();
