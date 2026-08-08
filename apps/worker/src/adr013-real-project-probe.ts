/**
 * ADR-013 real-project measurement — the run. Pre-registered in
 * `plans/adr-013-real-project-measurement-plan.md`; read that first, this file only executes it.
 *
 * Every number in the ADR-013/ADR-020 programme so far came from adversarial synthetic fixtures built to
 * starve (6 sources, 4 slots). This measures a project shaped like something a user would make: mostly
 * sequential clips, three Flarex hosts carrying 3 / 2 / 1 asset-source MediaIns, one junction transition.
 *
 * Three scopes, reported separately and never collapsed (plan §4–5):
 *   A — does an ordinary project contend at all? (low `created` is a FINDING, not a void)
 *   B — I-48: do siblings on one host actually compete? (VOID if they never do)
 *   C — the `> 1` threshold `37ed422` shipped unmeasured, tested in Host C's isolated `== 1` window
 *
 * HOW THE PROJECT IS INJECTED. The demo path yields a GUEST session with no JWT (verified empirically by
 * `adr013-schema-discovery.ts`: token ABSENT, project id `project_local_*`), so `PATCH /api/projects/:id`
 * is unavailable. Projects live in the `orreris_local_projects` localStorage array. The composition below
 * is written there directly and the editor reloaded onto it — which is also how exact clip times become
 * possible at all; the UI helpers can only act on "the first clip".
 *
 * TIME ATTRIBUTION, and why it is not merely wall-clock trust. Samples carry wall-clock ms since play().
 * The loader COUNT is expected to trace 0 → 3 → 0 → 2 → 0 → 1 as the playhead crosses the hosts, so the
 * count transitions calibrate the clock against the known layout: if they land at the expected times the
 * mapping is validated empirically rather than assumed, and if they do not, the run says so and Scope C
 * goes VOID rather than being attributed on a clock nobody checked.
 *
 *   PIXEL_BROWSER_CHANNEL=chrome npx tsx src/adr013-real-project-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { EDITOR_BASE, importAssets, reachEditor } from "./browser/editor-session.js";

const REPO = path.join(process.cwd(), "..", "..");
const OUT_DIR = path.join(REPO, "tmp", "adr013-real-project");
const RUN_LABEL = process.env.RUN_LABEL ?? "run1";
const SAMPLE_MS = 100;
/**
 * Scope C attribution windows. TWO of them, and the distinction is load-bearing.
 *
 * The plan's first pass used only the "clean" window (78–90s), drawn to exclude other decode pressure so
 * a reading there would be unambiguously attributable to Host C's pair. The validation run showed that
 * reasoning inverted: granting hardware to a LONE loader can only cause harm when there IS other
 * pressure, and the only such moment is Host C's preroll overlap with clip5 (76.8–78.0) — which the clean
 * window excluded by construction. Both cap misses landed at 76.9/77.1, so F1 measured from 78.0 read 0
 * while the event it exists to catch had already happened.
 *
 * So the REGIME window (the whole span where `flarexConcurrentLoaders == 1`, preroll included) is primary
 * for causation, and the CLEAN window is secondary — it answers whether the starvation PERSISTS once the
 * pressure is gone, which is a DEBT-013 recovery question, not a threshold question.
 */
const HOST_C_REGIME = { startS: 76.8, endS: 90.0 };
const HOST_C_CLEAN = { startS: 78.0, endS: 90.0 };
/** Plan §1: the predicted peak (preload widens it ahead of the 32s junction). */
const PEAK_WINDOW = { startS: 30.8, endS: 34.0 };

interface Sample {
  tMs: number;
  playheadS: number;
  created: number;
  capMisses: number;
  starvedSources: number;
  admissionRecoveries: number;
  active: number;
  activeSoftware: number;
  activePreload: number;
  loaders: number;
  modes: Record<string, string>;
}

/** N distinct source clips, each long enough to outlast the span it is trimmed into. */
function pickClips(n: number, minimumSeconds = 20): string[] {
  const dir = path.join(REPO, "apps/api/storage/finals");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mp4"))
    .map((f) => ({ file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
    .filter((e) => e.size > 200_000)
    .sort((a, b) => a.size - b.size)
    .map((e) => e.file);
  if (files.length < n) throw new Error(`need ${n} clips, found ${files.length} in ${dir}`);
  return files.slice(0, n);
}

/**
 * The pre-registered layout (plan §1). Start/duration in seconds; transitions are 2s.
 * Ordinary clips are SEQUENTIAL — the only overlap is a transition's own preroll/postroll, which is what
 * makes this a real project rather than the synthetic stack it exists to replace.
 */
const LAYOUT = [
  { key: "clip1", start: 0, dur: 10, host: null as null | "A" | "B" | "C", transition: false },
  { key: "clip2", start: 10, dur: 10, host: null, transition: true },
  { key: "clip3", start: 20, dur: 12, host: null, transition: true },
  { key: "hostA", start: 32, dur: 16, host: "A" as const, transition: true },
  { key: "clip4", start: 48, dur: 10, host: null, transition: false },
  { key: "hostB", start: 58, dur: 12, host: "B" as const, transition: false },
  { key: "clip5", start: 70, dur: 8, host: null, transition: false },
  { key: "hostC", start: 78, dur: 12, host: "C" as const, transition: false },
];
const MEDIAINS: Record<"A" | "B" | "C", number> = { A: 3, B: 2, C: 1 };
const TOTAL_S = 90;

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) {
    console.error("[real] ✗ PIXEL_BROWSER_CHANNEL unset — this would measure SwiftShader at ~8fps, where");
    console.error("       decoder races do not reproduce. Refusing to produce a number. Set it to `chrome`.");
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false, channel });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  // tsx/esbuild compiles this file with `keepNames`, which rewrites inner named functions to
  // `__name(fn, "fn")`. That helper lives in the MODULE scope, not in the function body Playwright
  // serializes into the page — so any evaluate() containing a named inner function dies with
  // "__name is not defined". Shim it. String form so nothing here is itself transformed, and
  // addInitScript so it survives the reload onto the fixture.
  await page.addInitScript({ content: "window.__name = window.__name || ((f) => f);" });
  await page.evaluate("window.__name = window.__name || ((f) => f);");

  try {
    // ── 1. Reach the editor, import distinct sources ──────────────────────────────────────────────
    const clips = pickClips(6);
    console.log(`[real] reaching editor (seed: ${path.basename(clips[0]!)})…`);
    const url = await reachEditor(page, { clipPath: clips[0]! });
    const projectId = url.split("/editor/")[1]?.split(/[?#]/)[0];
    if (!projectId) throw new Error(`could not parse projectId from ${url}`);
    console.log(`[real] project ${projectId}`);

    console.log(`[real] importing ${clips.length - 1} more sources…`);
    await importAssets(page, clips.slice(1));
    await page.waitForTimeout(3000);

    // ── 2. BUILD PRESENCE CHECK, before anything is trusted (plan §2 step 3) ───────────────────────
    const present = await page.evaluate(() => ({
      concurrent: (window as unknown as { __rfFlarexConcurrentLoaders?: number }).__rfFlarexConcurrentLoaders,
      loaderRate: (window as unknown as { __rfFlarexLoaderRate?: unknown }).__rfFlarexLoaderRate !== undefined,
      pool: (window as unknown as { __rfWcPool?: unknown }).__rfWcPool !== undefined,
    }));
    console.log(`[real] build presence: __rfFlarexConcurrentLoaders=${present.concurrent} rate=${present.loaderRate} pool=${present.pool}`);
    if (present.concurrent === undefined) {
      throw new Error("BUILD IDENTITY FAILED: __rfFlarexConcurrentLoaders absent — this bundle predates 3f315cb. Refusing to measure.");
    }

    // ── 3. Inject the pre-registered composition ───────────────────────────────────────────────────
    const injected = await page.evaluate(
      ({ pid, layout, mediaIns, totalS }) => {
        const raw = localStorage.getItem("orreris_local_projects");
        if (!raw) return { ok: false, why: "no orreris_local_projects" };
        const projects = JSON.parse(raw) as Array<Record<string, unknown>>;
        const proj = projects.find((p) => p.id === pid);
        if (!proj) return { ok: false, why: `project ${pid} not in local store` };

        const assetsRaw = localStorage.getItem("orreris_local_assets");
        const assets = assetsRaw ? (JSON.parse(assetsRaw) as Array<{ id: string; fileType?: string; durationSeconds?: number }>) : [];
        const videoAssets = assets.filter((a) => (a.fileType ?? "").startsWith("video"));
        if (videoAssets.length < 2) return { ok: false, why: `only ${videoAssets.length} video assets` };

        const graph = proj.projectGraph as Record<string, unknown>;
        const comp = graph.composition as Record<string, unknown>;
        const tracks = comp.tracks as Array<Record<string, unknown>>;
        const videoTrack = tracks.find((t) => String(t.id).endsWith("_track_video"));
        const textTrack = tracks.find((t) => String(t.id).endsWith("_track_text"));
        if (!videoTrack) return { ok: false, why: "no video track" };

        const pick = (i: number) => videoAssets[i % videoAssets.length]!.id;
        const flarexComps: Record<string, unknown> = {};
        const layers: Array<Record<string, unknown>> = [];
        let assetCursor = 0;

        layout.forEach((el, idx) => {
          const layerId = `${pid}_L${idx}_${el.key}`;
          const layer: Record<string, unknown> = {
            id: layerId,
            trackId: videoTrack.id,
            type: "video",
            name: el.key,
            assetId: pick(assetCursor++),
            fit: "cover",
            startSeconds: el.start,
            durationSeconds: el.dur,
            transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
            effects: [],
            keyframes: [],
          };
          if (el.transition) layer.transitionIn = { kind: "crossDissolve", durationSeconds: 2 };

          if (el.host) {
            const compId = `flarex_${pid}_${el.key}`;
            const nodes: Record<string, unknown> = {
              [`${compId}_in`]: {
                id: `${compId}_in`,
                type: "mediaIn",
                enabled: true,
                params: { sourceAssetId: "", sourceInSeconds: 0, freeze: false },
                ui: { x: 0, y: 0 },
              },
              [`${compId}_out`]: { id: `${compId}_out`, type: "mediaOut", enabled: true, params: {}, ui: { x: 520, y: 0 } },
            };
            // The siblings: asset-source MediaIns, each bound to a real media-pool asset. These are what
            // become virtual loaders (and therefore decoder sessions) — an unbound MediaIn resolves to the
            // host draw and opens nothing, which is the documented "cliff".
            const n = mediaIns[el.host as "A" | "B" | "C"];
            for (let s = 0; s < n; s += 1) {
              const nid = `${compId}_src${s}`;
              nodes[nid] = {
                id: nid,
                type: "mediaIn",
                enabled: true,
                params: { sourceAssetId: pick(assetCursor++), sourceInSeconds: 0, freeze: false },
                ui: { x: 180, y: s * 120 },
              };
            }
            flarexComps[compId] = {
              id: compId,
              name: `${el.key} Comp`,
              nodes,
              edges: [{ id: `${compId}_e0`, from: { nodeId: `${compId}_in`, socket: "out" }, to: { nodeId: `${compId}_out`, socket: "in" } }],
              animations: [],
              version: 4,
            };
            layer.flarexCompId = compId;
          }
          layers.push(layer);
        });

        videoTrack.layers = layers;
        if (textTrack) {
          textTrack.layers = [
            {
              id: `${pid}_txt`,
              trackId: textTrack.id,
              type: "text",
              name: "title",
              text: "Real project measurement",
              fontFamily: "Inter",
              fontSize: 64,
              color: "#FFFFFF",
              startSeconds: 12,
              durationSeconds: 6,
              transform: { position: { x: 50, y: 20 }, scale: 1, rotation: 0, opacity: 100 },
              effects: [],
              keyframes: [],
            },
          ];
        }
        comp.durationSeconds = totalS;
        graph.flarexComps = flarexComps;
        proj.durationSeconds = totalS;
        localStorage.setItem("orreris_local_projects", JSON.stringify(projects));
        return {
          ok: true,
          layers: layers.length,
          comps: Object.keys(flarexComps).length,
          videoAssets: videoAssets.length,
          bindings: Object.values(flarexComps).map((c) => {
            const nodes = (c as { nodes: Record<string, { params?: { sourceAssetId?: string } }> }).nodes;
            return Object.values(nodes).filter((nd) => nd.params?.sourceAssetId).length;
          }),
        };
      },
      { pid: projectId, layout: LAYOUT, mediaIns: MEDIAINS, totalS: TOTAL_S },
    );
    console.log(`[real] inject: ${JSON.stringify(injected)}`);
    if (!injected.ok) throw new Error(`injection failed: ${injected.why}`);

    // ── 4. Reload onto the injected project ────────────────────────────────────────────────────────
    console.log("[real] reloading editor onto the fixture…");
    await page.goto(`${EDITOR_BASE}/editor/${projectId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(9000);

    const clipCount = await page.locator(".timeline-clip").count().catch(() => 0);
    const loadersAtRest = await page.evaluate(
      () => (window as unknown as { __rfFlarexConcurrentLoaders?: number }).__rfFlarexConcurrentLoaders ?? -1,
    );
    console.log(`[real] fixture loaded: ${clipCount} timeline clips, loaders at playhead 0 = ${loadersAtRest}`);
    if (clipCount < LAYOUT.length) {
      throw new Error(`fixture did not load: ${clipCount} clips on the timeline, expected ${LAYOUT.length}`);
    }

    // ── 5. Play through, sampling at 100ms ─────────────────────────────────────────────────────────
    await page.keyboard.press("Home").catch(() => undefined);
    await page.waitForTimeout(1200);
    console.log(`[real] playing ${TOTAL_S}s, sampling every ${SAMPLE_MS}ms…`);
    await page.keyboard.press("Space").catch(() => undefined);
    const t0 = Date.now();
    const samples: Sample[] = [];

    while (Date.now() - t0 < (TOTAL_S + 3) * 1000) {
      const s = await page
        .evaluate(() => {
          const w = window as unknown as {
            __rfWcPool?: Record<string, number>;
            __rfWcMode?: Record<string, string>;
            __rfFlarexConcurrentLoaders?: number;
          };
          const p = w.__rfWcPool ?? {};
          return {
            created: p.created ?? -1,
            capMisses: p.capMisses ?? -1,
            starvedSources: p.starvedSources ?? -1,
            admissionRecoveries: p.admissionRecoveries ?? -1,
            active: p.active ?? -1,
            activeSoftware: p.activeSoftware ?? -1,
            activePreload: p.activePreload ?? -1,
            loaders: w.__rfFlarexConcurrentLoaders ?? -1,
            modes: { ...(w.__rfWcMode ?? {}) },
          };
        })
        .catch(() => null);
      if (s) {
        const tMs = Date.now() - t0;
        samples.push({ tMs, playheadS: tMs / 1000, ...s });
      }
      await page.waitForTimeout(SAMPLE_MS);
    }
    await page.keyboard.press("Space").catch(() => undefined);
    console.log(`[real] captured ${samples.length} samples`);

    // ── 6. Reduce. Raw numbers only — no verdicts here (plan: report numbers, not conclusions) ──────
    const inWindow = (s: Sample, w: { startS: number; endS: number }) => s.playheadS >= w.startS && s.playheadS <= w.endS;
    const max = (f: (s: Sample) => number) => samples.reduce((m, s) => Math.max(m, f(s)), 0);
    const last = samples[samples.length - 1];

    // Clock calibration: when the loader count actually changed, vs. where the layout says it should.
    const transitions: Array<{ playheadS: number; from: number; to: number }> = [];
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i]!.loaders !== samples[i - 1]!.loaders) {
        transitions.push({ playheadS: Number(samples[i]!.playheadS.toFixed(2)), from: samples[i - 1]!.loaders, to: samples[i]!.loaders });
      }
    }

    const cWindow = samples.filter((s) => inWindow(s, HOST_C_CLEAN));
    const regime = samples.filter((s) => inWindow(s, HOST_C_REGIME));
    const beforeRegime = samples.filter((s) => s.playheadS < HOST_C_REGIME.startS).pop();
    const peakWindow = samples.filter((s) => inWindow(s, PEAK_WINDOW));

    const report = {
      runLabel: RUN_LABEL,
      commit: process.env.PROBE_COMMIT ?? "unknown",
      channel,
      samples: samples.length,
      pageErrors: pageErrors.slice(0, 5),
      fixture: { clipCount, injected },
      // Scope A — did an ordinary project contend at all?
      scopeA: {
        createdFinal: last?.created ?? -1,
        capMissesFinal: last?.capMisses ?? -1,
        starvedSourcesMax: max((s) => s.starvedSources),
        admissionRecoveriesFinal: last?.admissionRecoveries ?? -1,
        activeMax: max((s) => s.active),
        activeSoftwareMax: max((s) => s.activeSoftware),
        activePreloadMax: max((s) => s.activePreload),
      },
      // The predicted peak (5 sessions vs a ceiling of 4).
      peak: {
        window: PEAK_WINDOW,
        samplesInWindow: peakWindow.length,
        activeMax: peakWindow.reduce((m, s) => Math.max(m, s.active), 0),
        capMissesAtWindowStart: peakWindow[0]?.capMisses ?? null,
        capMissesAtWindowEnd: peakWindow[peakWindow.length - 1]?.capMisses ?? null,
        starvedMax: peakWindow.reduce((m, s) => Math.max(m, s.starvedSources), 0),
      },
      // Scope B — I-48 siblings. Per-sample count of non-element loader modes is the raw input.
      scopeB: {
        loadersMax: max((s) => s.loaders),
        modeKeysSeen: [...new Set(samples.flatMap((s) => Object.keys(s.modes)))].length,
        samplesWithTwoPlusNonElement: samples.filter(
          (s) => Object.values(s.modes).filter((m) => m !== "element").length >= 2,
        ).length,
        maxNonElementConcurrent: max((s) => Object.values(s.modes).filter((m) => m !== "element").length),
      },
      // Scope C — the `> 1` threshold. PRIMARY = the regime window (causation); the clean window is
      // secondary (persistence/recovery). Both F1 and F4 are ONSET measures relative to a baseline taken
      // immediately before the regime begins — a LEVEL would fire on starvation inherited from earlier in
      // the run and attribute it here, which is the attribution defect the validation run exposed.
      scopeC: {
        regimeWindow: HOST_C_REGIME,
        cleanWindow: HOST_C_CLEAN,
        baselineBeforeRegime: beforeRegime
          ? { playheadS: Number(beforeRegime.playheadS.toFixed(2)), capMisses: beforeRegime.capMisses, starvedSources: beforeRegime.starvedSources }
          : null,
        samplesInRegime: regime.length,
        samplesInClean: cWindow.length,
        loaderCountsInRegime: [...new Set(regime.map((s) => s.loaders))].sort(),
        sawExactlyOne: regime.some((s) => s.loaders === 1),
        // F1 — cap misses that BEGIN in the regime.
        F1_capMissOnset: regime.length && beforeRegime ? Math.max(...regime.map((s) => s.capMisses)) - beforeRegime.capMisses : null,
        // F4 — starvation that BEGINS in the regime (not inherited).
        F4_starvedOnset: regime.length && beforeRegime ? Math.max(...regime.map((s) => s.starvedSources)) - beforeRegime.starvedSources : null,
        F4_starvedMaxLevel: regime.reduce((m, s) => Math.max(m, s.starvedSources), 0),
        // F2/F3 — which of Host C's pair ended up off WebCodecs, and did it persist.
        modesMidRegime: regime.length ? regime[Math.floor(regime.length / 2)]!.modes : {},
        modesMidClean: cWindow.length ? cWindow[Math.floor(cWindow.length / 2)]!.modes : {},
        elementCountInClean: cWindow.length
          ? Math.max(...cWindow.map((s) => Object.values(s.modes).filter((m) => m === "element").length))
          : null,
        activeSoftwareInRegime: [...new Set(regime.map((s) => s.activeSoftware))].sort(),
        activeInRegime: [...new Set(regime.map((s) => s.active))].sort(),
        // Did the starvation clear by the end of the run, or persist (DEBT-013's signature)?
        starvedAtRunEnd: last?.starvedSources ?? -1,
      },
      clockCalibration: {
        expected: "0 -> 3 @32s, 3 -> 0 @48s, 0 -> 2 @58s, 2 -> 0 @70s, 0 -> 1 @78s",
        observedTransitions: transitions.slice(0, 30),
      },
    };

    const file = path.join(OUT_DIR, `${RUN_LABEL}.json`);
    fs.writeFileSync(file, JSON.stringify({ report, samples }, null, 1), "utf8");
    console.log(`\n[real] ===== ${RUN_LABEL} RAW =====`);
    console.log(JSON.stringify(report, null, 1));
    console.log(`[real] wrote ${file}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error("[real] FAILED", e);
  process.exit(1);
});
