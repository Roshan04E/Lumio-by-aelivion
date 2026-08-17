/**
 * DEBT-032 mechanism hunt. Two mechanisms are already falsified (request ordering/concurrency;
 * main-thread GL-work interleaving — see `flarex-decode-scheduling-probe.ts` and the tracker entry).
 * This tests the founder's own leading hypothesis, flagged by them as unverified: eviction thrash under
 * a byte budget forcing a seek-back-to-keyframe-and-redecode instead of a cheap next-frame decode, worse
 * as N rises because whatever budget is in play gets tighter per provider.
 *
 * The specific constant named (`PINNED_FRAMES_PER_PROVIDER` in `apps/web/src/playback/
 * flarex-source-providers.ts`) belongs to the EDITOR PREVIEW's multi-provider byte-budget system, not
 * the export-mode `FrameProvider` (`apps/web/src/export/source-decoder.ts` ->
 * `apps/web/src/export/webcodecs-decoder.ts`) that DEBT-030/032's actual measurement exercises — those
 * are two separate provider systems in two separate modules, and the export path never imports
 * `flarex-source-providers.ts`. So the NAMED mechanism cannot literally be the cause of DEBT-032's
 * number. But the STRUCTURAL idea (a seek-and-redecode where a cheap next-frame decode was expected)
 * has a directly analogous, already-instrumented signal in the code DEBT-032 actually exercises:
 * `wcDecoderResetStats.hardReset` (`webcodecs-decoder.ts:140`, exposed as `window.__rfWcDecoder`), which
 * the code's own doc comment describes as counting "backward seeks/shuttle, forward GOP crossings past
 * the fed cursor" and adds: "A high count during steady forward playback signals the session is
 * thrashing rather than streaming." That is precisely the founder's predicted signature, already wired,
 * no new instrumentation needed — just read it before/after the exact request pattern that produced the
 * explosion, per N.
 *
 * If per-provider hard-reset rate is flat across N, the seek/reset-thrash story is dead for THIS
 * mechanism too (regardless of whether an analogous byte budget exists elsewhere) and this probe says so
 * plainly. If it climbs with N, that is the signature confirmed.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-debt032-reset-probe.ts
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
const WARMUP_STEPS = 2;
const MEASURED_STEPS = 6;

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
  assertQuietBrowserMachine({ label: "flarex-debt032-reset-probe" });
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
  process.stdout.write(`renderer: ${regime}${software ? "  ** SOFTWARE — ABORTING **\n" : "\n"}`);
  if (software) {
    await browser.close();
    process.exit(1);
  }

  const results = await page.evaluate(
    async (payload: { mods: Record<string, string>; nLadder: number[]; warmupSteps: number; measuredSteps: number }) => {
      const { nLadder, warmupSteps, measuredSteps } = payload;
      const { createFrameProvider } = await import(/* @vite-ignore */ payload.mods.sourceDecoder!);
      // The reset counter lives in webcodecs-decoder.ts and self-registers on `window` — import it so
      // the SAME module instance backs both `createFrameProvider` and this read (module singletons are
      // per-URL-per-page, so this is safe) and read the live counter rather than assuming the global.
      await import(/* @vite-ignore */ payload.mods.webcodecsDecoder!);

      const readHardReset = (): number => (window as unknown as { __rfWcDecoder?: { hardReset: number } }).__rfWcDecoder?.hardReset ?? -1;

      const out: { n: number; resetsBefore: number; resetsAfter: number; resetDelta: number; totalMs: number }[] = [];

      for (const n of nLadder) {
        const providers: any[] = [];
        for (let i = 0; i < n; i++) {
          const url = `${location.origin}/__local-clip__/${i}`;
          providers.push(await createFrameProvider(url, "video"));
        }
        // Warmup: walk forward a couple of steps, discarded, so every N starts from the same settled state.
        for (let s = 0; s < warmupSteps; s++) {
          for (const p of providers) await p.getFrame(s / 30);
        }
        const resetsBefore = readHardReset();
        const t0 = performance.now();
        for (let s = 0; s < measuredSteps; s++) {
          const t = (warmupSteps + s) / 30;
          for (const p of providers) await p.getFrame(t);
        }
        const totalMs = performance.now() - t0;
        const resetsAfter = readHardReset();
        out.push({ n, resetsBefore, resetsAfter, resetDelta: resetsAfter - resetsBefore, totalMs });
        for (const p of providers) p.dispose?.();
      }

      return out;
    },
    {
      mods: {
        sourceDecoder: fsSpecifier("apps/web/src/export/source-decoder.ts"),
        webcodecsDecoder: fsSpecifier("apps/web/src/export/webcodecs-decoder.ts"),
      },
      nLadder: N_LADDER,
      warmupSteps: WARMUP_STEPS,
      measuredSteps: MEASURED_STEPS,
    },
  );

  await browser.close();

  console.log(`\n=== DEBT-032: does hard-reset (seek-to-keyframe) rate rise with N? (${MEASURED_STEPS} incremental frame-steps/N, real WebCodecs) ===`);
  console.log(`  requests/N = N providers x ${MEASURED_STEPS} steps`);
  for (const row of results) {
    const requests = row.n * MEASURED_STEPS;
    const perProvider = row.n > 0 ? row.resetDelta / row.n : 0;
    console.log(
      `  N=${String(row.n).padStart(2)}  totalMs=${row.totalMs.toFixed(1).padStart(7)}  hardReset delta=${String(row.resetDelta).padStart(4)} ` +
        `/ ${requests} requests  (${perProvider.toFixed(2)}/provider)  [counter before=${row.resetsBefore}, after=${row.resetsAfter}]`
    );
  }

  const n1 = results.find((r: any) => r.n === 1)!;
  const nMax = results[results.length - 1]!;
  const n1PerProvider = n1.n > 0 ? n1.resetDelta / n1.n : 0;
  const nMaxPerProvider = nMax.n > 0 ? nMax.resetDelta / nMax.n : 0;
  console.log(
    `\n  per-provider hard-reset rate: N=1 -> ${n1PerProvider.toFixed(2)}, N=${nMax.n} -> ${nMaxPerProvider.toFixed(2)}  ` +
      (nMaxPerProvider <= n1PerProvider + 0.5
        ? "FLAT / near-zero — the seek-and-redecode-under-eviction story is DEAD for this code path. Say so plainly."
        : "RISES with N — matches the founder's predicted signature. This is live, not dead.")
  );

  console.log("\nflarex-debt032-reset-probe: complete (measurement only, nothing asserted)");
}

void main();
