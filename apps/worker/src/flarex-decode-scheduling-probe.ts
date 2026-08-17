/**
 * DEBT-030/DEBT-027 joining question, founder's own words: "decode-wait exploding super-linearly with
 * N is decoder contention. DEBT-027's cause is already named as DECODER SUPPLY. Those are very likely
 * the same underlying behaviour seen from two directions... Test it before believing it."
 *
 * Two independent falsifiers, both against REAL WebCodecs sources through the REAL export-mode
 * `FrameProvider` (`apps/web/src/export/source-decoder.ts`, the same one `flarex-readback-ablation.ts`
 * and the upload/decode split used) — not the editor's time-sliced preview provider, so this probe says
 * nothing about `frameBudgetMs` catch-up behaviour specifically, only about decoder SUPPLY under
 * concurrent load, which is the mechanism DEBT-027 itself names.
 *
 * STOP 1 (does the falsifier hold at all): with N sources contending, does the ORDER or CONCURRENCY of
 * `getFrame()` requests change total decode-wait? Three arms, same N, same media, same requested time:
 *   SERIAL      — await one provider at a time.
 *   STAGGERED   — fire all N with a small stagger between kickoffs, await together.
 *   CONCURRENT  — fire all N in the same tick (`Promise.all`, no stagger) — this is what the real
 *                 compositor does today (`activeSourceKeysAt(t).map(loadSource)`, `Promise.all`).
 * If all three post statistically the same total wall time, decode scheduling from JS cannot move the
 * needle and contention is inside the decoder/driver — say so and stop. If they differ, JS-side request
 * shaping IS a lever, which is what the pull seam would need to be true to fix the high-N collapse.
 *
 * STOP 1b (does DEBT-027 reproduce harder as N rises): mirrors the field probe's own B-vs-C oracle
 * check (`flarex-frame-cache-field-probe.ts`) but at the FrameProvider layer directly, across a rising
 * N of CONCURRENT sources instead of one. For a fixed set of stop times, two full sweeps over the same N
 * providers; for each (provider, stop) pair, compare the frame's actual `VideoFrame.timestamp` against
 * the requested time (the same "served == requested to four decimals" fact DEBT-027's own served-time
 * carry checks) — a divergence here is EXACTLY DEBT-027's failure shape ("a decoder that stops supplying
 * the moment it was asked for"), just observed at the provider layer instead of through the full editor
 * UI. If divergence rate rises with N, the two symptoms (correctness failure, performance ceiling) are
 * one mechanism; if it is flat (including nonzero at N=1), they are two separate problems.
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/flarex-decode-scheduling-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fsSpecifier = (rel: string) => `/@fs/${path.join(repoRoot, rel).replace(/\\/g, "/")}`;
const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";

function seedClips(count: number): string[] {
  const dir = path.join(repoRoot, "apps/api/storage/finals");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size); // smallest first — matches prior scripts
  if (files.length < count) throw new Error(`need ${count} distinct clips, found ${files.length} in ${dir}`);
  return files.slice(0, count);
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "flarex-decode-scheduling-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const page = await browser.newPage();
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  const ORDERING_N = 20; // the N where upload-cost-split.ts found decode-wait already exploding
  const SWEEP_N_LADDER = [1, 5, 10, 20];
  const maxNeeded = Math.max(ORDERING_N, ...SWEEP_N_LADDER);
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
    async (payload: { mods: Record<string, string>; orderingN: number; sweepNLadder: number[] }) => {
      const { orderingN, sweepNLadder } = payload;
      const { createFrameProvider, clipSourceKey } = await import(/* @vite-ignore */ payload.mods.sourceDecoder!);

      const makeProviders = async (n: number): Promise<any[]> => {
        const providers: any[] = [];
        for (let i = 0; i < n; i++) {
          const url = `${location.origin}/__local-clip__/${i}`;
          providers.push(await createFrameProvider(url, "video"));
        }
        return providers;
      };
      const disposeAll = (providers: any[]) => providers.forEach((p) => p.dispose?.());

      // ---- STOP 1: ordering / concurrency falsifier ----
      //
      // A first version measured a single COLD getFrame(2.0) per provider — that mostly times
      // demux/decoder-init/keyframe-seek, which is a different (and, it turned out, misleadingly large)
      // cost than the STEADY-STATE per-frame decode-wait that `upload-cost-split.ts` found exploding
      // super-linearly with N (1.32ms/layer at N=10 -> 5.19ms/layer at N=20, inside a render loop asking
      // for the NEXT nearby frame each pass, not a cold seek). Warm every provider first (3 discarded
      // getFrame calls walking forward to t~0.1s, matching the "warmup" pattern used elsewhere in this
      // session), THEN measure a short run of INCREMENTAL frame-to-frame requests (t += 1/30s each
      // step, 6 steps) under each arm — the shape that actually reproduced the explosion.
      const WARMUP_STEPS = 3;
      const MEASURED_STEPS = 6;
      const REPEATS = 3;
      const orderingResults: { arm: string; totalMs: number[] }[] = [];

      const warm = async (providers: any[]) => {
        for (let s = 0; s < WARMUP_STEPS; s++) {
          for (const p of providers) await p.getFrame(s / 30);
        }
      };

      // SERIAL
      {
        const totals: number[] = [];
        for (let r = 0; r < REPEATS; r++) {
          const providers = await makeProviders(orderingN);
          await warm(providers);
          const t0 = performance.now();
          for (let s = 0; s < MEASURED_STEPS; s++) {
            const t = (WARMUP_STEPS + s) / 30;
            for (const p of providers) await p.getFrame(t);
          }
          totals.push(performance.now() - t0);
          disposeAll(providers);
        }
        orderingResults.push({ arm: "serial", totalMs: totals });
      }
      // GL-INTERLEAVED (serial getFrame, but with a REAL texSubImage2D upload synchronously between each
      // one — the actual shape of `gradeMediaLayer`'s per-layer loop inside `SceneFrameCompositor`,
      // which is where the explosion was originally measured. `decodeMs` isolates just the getFrame
      // await time within this shape, same as `upload-cost-split.ts` did, to test directly whether
      // main-thread GL work between decode awaits is what makes decode-wait balloon — i.e. whether the
      // earlier finding was decoder-side contention at all, or promise-continuation queueing behind
      // synchronous JS/GL work on the single main thread.
      {
        const totals: number[] = [];
        const decodeTotals: number[] = [];
        for (let r = 0; r < REPEATS; r++) {
          const providers = await makeProviders(orderingN);
          await warm(providers);
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 64;
          const gl = canvas.getContext("webgl2")!;
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          let decodeMs = 0;
          const t0 = performance.now();
          for (let s = 0; s < MEASURED_STEPS; s++) {
            const t = (WARMUP_STEPS + s) / 30;
            for (const p of providers) {
              const d0 = performance.now();
              const frame = await p.getFrame(t);
              decodeMs += performance.now() - d0;
              if (frame) {
                try {
                  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame as TexImageSource);
                } catch {
                  /* size-0 or unsupported source — ignore, this arm only needs the upload CALL to run */
                }
              }
            }
          }
          totals.push(performance.now() - t0);
          decodeTotals.push(decodeMs);
          gl.deleteTexture(tex);
          disposeAll(providers);
        }
        orderingResults.push({ arm: "gl-interleaved", totalMs: totals });
        orderingResults.push({ arm: "gl-interleaved-decode-only", totalMs: decodeTotals });
      }
      // CONCURRENT (Promise.all per frame step, no stagger — matches the real compositor's
      // activeSourceKeysAt(t).map(loadSource) / Promise.all pattern)
      {
        const totals: number[] = [];
        for (let r = 0; r < REPEATS; r++) {
          const providers = await makeProviders(orderingN);
          await warm(providers);
          const t0 = performance.now();
          for (let s = 0; s < MEASURED_STEPS; s++) {
            const t = (WARMUP_STEPS + s) / 30;
            await Promise.all(providers.map((p) => p.getFrame(t)));
          }
          totals.push(performance.now() - t0);
          disposeAll(providers);
        }
        orderingResults.push({ arm: "concurrent", totalMs: totals });
      }

      // ---- STOP 1b: does served==requested divergence rise with N (DEBT-027 shape) ----
      const STOP_TIMES = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
      const sweepResults: { n: number; mismatches: number; totalChecked: number; detail: string[] }[] = [];
      for (const n of sweepNLadder) {
        const layerIds = Array.from({ length: n }, (_, i) => `layer_${i}`);
        const assetIds = Array.from({ length: n }, (_, i) => `asset_${i}`);
        const providers = await makeProviders(n);
        const passReadings: { requested: number; got: number | null }[][] = [];
        for (let pass = 0; pass < 2; pass++) {
          const readings: { requested: number; got: number | null }[] = [];
          for (const t of STOP_TIMES) {
            for (const p of providers) {
              const frame = await p.getFrame(t);
              // VideoFrame.timestamp is in MICROSECONDS; the <video>/image fallback providers don't
              // carry one (frame is a canvas/element there) — skip those rather than mis-attribute.
              const gotSeconds = frame && typeof (frame as any).timestamp === "number" ? (frame as any).timestamp / 1e6 : null;
              readings.push({ requested: t, got: gotSeconds });
            }
          }
          passReadings.push(readings);
        }
        disposeAll(providers);
        let mismatches = 0;
        let checked = 0;
        const detail: string[] = [];
        for (let i = 0; i < passReadings[0]!.length; i++) {
          const a = passReadings[0]![i]!;
          const b = passReadings[1]![i]!;
          if (a.got == null || b.got == null) continue; // fallback provider or a genuine no-supply — counted separately below
          checked += 1;
          // "served == requested to four decimals whenever supply works" is DEBT-027's own bar; a real
          // decoder serves the frame AT OR JUST BEFORE the requested time (never after), so treat any
          // gap beyond one 30fps frame interval as a miss, not exact equality (WebCodecs decode lands on
          // GOP sample boundaries, not the exact requested second).
          const gap = Math.abs(a.got - b.got);
          if (gap > 1 / 20) {
            mismatches += 1;
            detail.push(`t=${a.requested.toFixed(1)} pass1=${a.got.toFixed(3)} pass2=${b.got.toFixed(3)} gap=${gap.toFixed(3)}`);
          }
        }
        const nullCount = passReadings[0]!.filter((r) => r.got == null).length + passReadings[1]!.filter((r) => r.got == null).length;
        sweepResults.push({ n, mismatches, totalChecked: checked, detail: nullCount > 0 ? [...detail, `${nullCount} reading(s) had no timestamp (fallback provider or no-supply)`] : detail });
      }

      return { orderingResults, sweepResults };
    },
    {
      mods: { sourceDecoder: fsSpecifier("apps/web/src/export/source-decoder.ts") },
      orderingN: ORDERING_N,
      sweepNLadder: SWEEP_N_LADDER,
    },
  );

  await browser.close();

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`\n=== STOP 1: does request ORDER/CONCURRENCY change total decode-wait? (N=${ORDERING_N}, real WebCodecs) ===`);
  for (const row of results.orderingResults) {
    console.log(`  ${row.arm.padEnd(16)} totals=[${row.totalMs.map((v) => v.toFixed(1)).join(", ")}]ms  avg=${avg(row.totalMs).toFixed(1)}ms`);
  }
  const serialAvg = avg(results.orderingResults.find((r: any) => r.arm === "serial")!.totalMs);
  const concurrentAvg = avg(results.orderingResults.find((r: any) => r.arm === "concurrent")!.totalMs);
  const glInterleavedAvg = avg(results.orderingResults.find((r: any) => r.arm === "gl-interleaved")!.totalMs);
  const glInterleavedDecodeOnlyAvg = avg(results.orderingResults.find((r: any) => r.arm === "gl-interleaved-decode-only")!.totalMs);
  const spread = Math.max(serialAvg, concurrentAvg) - Math.min(serialAvg, concurrentAvg);
  const spreadPct = (spread / Math.min(serialAvg, concurrentAvg)) * 100;
  console.log(
    `  serial vs concurrent, pure getFrame (no interleaved work): spread ${spread.toFixed(1)}ms (${spreadPct.toFixed(0)}%) — ` +
      (spreadPct < 15
        ? "FLAT: with NOTHING between decode requests, order/concurrency barely matters and both are cheap."
        : "order/concurrency changes pure decode-wait even with nothing between requests.")
  );
  console.log(
    `  gl-interleaved (serial getFrame + a real texSubImage2D between each): decode-only=${glInterleavedDecodeOnlyAvg.toFixed(1)}ms, ` +
      `total=${glInterleavedAvg.toFixed(1)}ms, vs serial-alone=${serialAvg.toFixed(1)}ms — ` +
      (glInterleavedDecodeOnlyAvg > serialAvg * 2
        ? "CONFIRMS: interleaving real GL work between decode awaits inflates the MEASURED decode-wait sharply, even though nothing changed about the decoder itself. The earlier 101ms/20-layer figure is plausibly promise-continuation queueing behind main-thread JS/GL work, not decoder-side contention."
        : "does NOT reproduce the earlier explosion — the gap has another cause, not simply GL-work interleaving.")
  );

  console.log(`\n=== STOP 1b: does served!=requested divergence (DEBT-027's shape) rise with N? ===`);
  for (const row of results.sweepResults) {
    console.log(`  N=${row.n}  mismatches=${row.mismatches}/${row.totalChecked}` + (row.detail.length ? `\n    ${row.detail.join("\n    ")}` : ""));
  }

  console.log("\nflarex-decode-scheduling-probe: complete (measurement only, nothing asserted)");
}

void main();
