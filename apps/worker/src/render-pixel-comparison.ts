import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderManifest } from "@orreris/render-templates";
import {
  createRenderComparisonFixture,
  renderComparisonArtifactDir,
  renderComparisonFixtureKeys,
  renderComparisonFrameSeconds,
  type RenderComparisonFixtureKey
} from "@orreris/shared";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { PNG } from "pngjs";
import { renderManifestStill } from "./remotion-renderer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDir = path.join(repoRoot, "tmp", renderComparisonArtifactDir);
const diffSummaryPath = path.join(artifactDir, "summary.json");

const diffThreshold = Number(process.env.PIXEL_DIFF_THRESHOLD ?? 0.16);
const maxDiffRatio = Number(process.env.PIXEL_MAX_DIFF_RATIO ?? 0.035);

// PER-FIXTURE BARS (2026-07-28). One global 3.5% has to be sized for the LOOSEST fixture in the
// sweep, which leaves it meaningless for the tight ones. Measured: the whole visual footprint of the
// v32i merge-blend fix was 1.43%, so the ASYMMETRIC form of that bug — the fix reaching one renderer
// and not the other — would have read 1.43% < 3.5% and PASSED on the very fixture built to catch it.
// A fixture's bar should reflect what that fixture actually achieves, not the worst case anywhere.
//
// Values are set from an observed full sweep with real headroom, never just above the reading: every
// entry here measured 0.000% (0-3 pixels of 2073600), so 0.5% leaves ~10000 pixels of slack. The
// web-preview capture is not byte-deterministic run to run (see v32m: max channel delta 8/255), but
// that jitter sits under pixelmatch's perceptual `threshold` and contributes ~0 differing pixels.
//
// Deliberately NOT listed: `advanced-transition` (close to the global budget, unrelated to the
// capture-timing defect below — keeps the loose global bar until someone investigates why it needs it).
// Updated 2026-08-09: re-measured across five separate sweeps this week (different sessions, different
// machine states) — `advanced-transition` reads 2.809% (80% of the 3.5% global budget), not the 3.131%
// originally recorded above. Figures only; neither bar nor the global threshold changed.
//
// `flarex-generators` MOVED OFF the loose bar 2026-08-13 (project-tracker/infrastructure.md v6): its
// 0.000%-vs-86.895% flake was a capture-timing race (`awaitCaptureReadiness` in this file), not
// picture non-determinism, and it is now gated on the same instrument that measures it rather than on
// a blind sleep. Measured 0.000% on 3 consecutive full sweeps post-fix, against a documented ~40%
// failure rate pre-fix — see 0.005 below, same tier as its siblings.
//
// An explicit PIXEL_MAX_DIFF_RATIO overrides every per-fixture bar — the escape hatch for a machine
// whose GPU rasterizes differently enough to make the tight bars flaky.
const fixtureMaxDiffRatio: Partial<Record<RenderComparisonFixtureKey, number>> = {
  "flarex-key-glow": 0.005,
  "flarex-curves": 0.005,
  "flarex-keyframed-blur": 0.005,
  "flarex-merge-blend": 0.005,
  "flarex-transform": 0.005,
  "flarex-ellipse-matte": 0.005,
  "flarex-reroute": 0.005,
  "flarex-multi-in": 0.005,
  "flarex-color-chain": 0.005,
  "flarex-unified-color": 0.005,
  "flarex-filter-stack": 0.005,
  // Measured 0.000% (0/2073600) on the full sweep that added this fixture — same methodology as the
  // entries above.
  "flarex-mismatched-aspect": 0.005,
  // DEBT-017 renderer-divergence coverage (NOT a DEBT-016 guard — see the fixture's own comment and
  // project-tracker/architectural-debt.md). Measured 0.000% (0/2073600) on the full 55-fixture sweep
  // that added this fixture; the pre-13 Flarex fixtures did not move.
  "flarex-host-transform": 0.005,
  // Slice 2 (tracked masks). Measured 0.000% and 0.004% on the sweep that added them — the mask's own
  // geometry is static in both, so the only thing moving is the track offset, and the two renderers
  // agree on it exactly.
  "flarex-tracked-mask-early": 0.005,
  "flarex-tracked-mask-late": 0.005,
  "flarex-generators": 0.005,
  /**
   * Stabilize is the one new fixture that cannot hold a 0.5% bar, and the reason is worth stating
   * rather than hiding behind the 3.5% global.
   *
   * Measured 1.123% — 23288/2073600 pixels, the SAME COUNT on three separate runs, so this is a
   * deterministic difference and not flake. The diff image is the tell: it is hairline outlines
   * tracing every high-contrast contour of the source graphic, with every region interior clean. That
   * is the two renderers' samplers rounding differently on a frame the auto-fit zoom has upscaled
   * 1.48×, and it scales with the source's total edge length, which is why this reads higher than
   * `flarex-transform` (which also scales, but by less and over a shorter contour).
   *
   * A structural failure — wrong sign, wrong offset, wrong zoom — does NOT look like this: it puts
   * thick doubled shapes and large filled areas into the diff, an order of magnitude above this bar.
   * 0.02 keeps ~78% headroom over the measured value while staying 1.75× tighter than the global.
   */
  "flarex-stabilize": 0.02,
  /**
   * The two spatial filters at their new maximum. Both measured 0.000% (0/2073600), so the bar is
   * the tightest in the table.
   *
   * A blur fixture landing at exactly zero deserves suspicion — a green gate on a picture where
   * nothing happened is this repo's classic void run — so it was checked the other way as well: both
   * renders were looked at, and both carry an unmistakable full-frame streak (a 27° smear and a
   * zoom sweep radiating from an off-centre point). The effect is emphatically running.
   *
   * What these two are really gating is the pair of things this change introduced that a shader in
   * this harness has never had: a loop whose bound is COMPUTED rather than a compile-time constant,
   * and a per-pixel tap-phase jitter. The jitter is the sharper risk — `glsl-hash.ts` exists because
   * a `sin`-based hash silently disagreed between these same two renderers and quietly invalidated
   * three fixtures' parity for weeks. 0/2073600 says the integer hash and the dynamic bound both
   * hold, at the setting where the tap count is at its cap and the jitter is at its most visible.
   */
  "flarex-directional-blur-max": 0.002,
  "flarex-radial-blur-max": 0.002,
  /**
   * Glow at radius 200, where the bloom blur runs on a 1/8-size copy and comes back up through a tent
   * filter. Measured 0.000% (0/2073600).
   *
   * Same suspicion applied as to the blurs, and the render answers it emphatically: the sun bleeds
   * across the top third of the frame and washes the whole sky. Nothing about this reads zero because
   * nothing happened.
   *
   * The pyramid is worth its own fixture because nothing else in the suite renders through one: level
   * sizes come from `ceil(w / 2^n)` and the taps read at `1/size` offsets, so a renderer that rounded a
   * level's dimensions differently would put a visibly different halo on screen. What this CANNOT see
   * is the risk the change actually carries — temporal shimmer lives between consecutive frames and
   * this compares one, so both renderers would crawl identically and still read 0.000%. That check is
   * `apps/worker/tmp/glow-motion.ts`; its result is in the audit's S3.7.
   */
  "flarex-glow-max": 0.002,
  /**
   * The Gaussian blur node at sigma 200, its first trip through the pyramid.
   *
   * Not redundant with `flarex-glow-max` even though both ride the same code: glow feeds the pyramid a
   * sparse brightpass that is mostly empty, while the blur node feeds it an OPAQUE FULL-FRAME plate, so
   * the frame edges carry content. The down chain samples with CLAMP_TO_EDGE while `BLUR_FS` treats
   * out-of-frame as transparent, and those two conventions only meet where there is something at the
   * border — which is here and not in the glow fixture.
   */
  "flarex-blur-max": 0.002,
  /**
   * The CLIP glow effect at radius 160 in edge mode — the pyramid's third and last consumer. Not
   * redundant with `flarex-glow-max`: that is the Flarex glow NODE, which lowers to `mode: "highlights"`
   * and blurs a sparse brightpass. This is the other mode entirely — a blurred ALPHA silhouette of a
   * text plate — so it is the one that would catch the tent upsample mishandling alpha, where a
   * brightpass carrying its weight in `.a` would not.
   *
   * Same 0.2% bar as its siblings for the same reason: a full-frame soft gradient is where a
   * one-code-value disagreement between the two renderers would spread over the most pixels, so the
   * strictest defensible bar is the informative one.
   */
  "glow-edge-max": 0.002,
  /**
   * THE LINEAR ARM (linear-light programme, slice 1). Same plate, same effects, same radii as the
   * `glow` and `blur` fixtures — one field different, the composition's `effectLight`.
   *
   * What these gate is narrower than it looks and worth stating, because a green run here is easy to
   * over-read. They prove the two renderers agree IN LINEAR: that the sRGB targets, the fixed-function
   * conversions, the threshold remap and the tint linearisation land identically in the web preview and
   * in Remotion. They do NOT prove the linear picture is right — two renderers agreeing about a wrong
   * transfer function is precisely the blind spot that let a truncated glow pass for two months
   * (DEBT-017). "Is it right?" is answered by the ratio measurement and by looking at the render, both
   * recorded in the commit; this bar answers "do the two agree?".
   *
   * 0.002 like their siblings: measured 0.000% on the sweep that added them.
   */
  "linear-glow": 0.002,
  "linear-blur": 0.002,
  /**
   * The linear arm's stylize pair. Same bars as their display twins (`stylize` 0.001%, `stylize-print`
   * 0.051%) because they render the same picture — the artistic family is `displayReferred` and opts
   * out of the linear stage, so these are byte-for-byte their twins and carry the twins' cross-renderer
   * noise, no more.
   */
  "linear-stylize": 0.005,
  "linear-stylize-print": 0.005,
  /**
   * DEBT-017 THIRD AXIS (2026-08-13) — the other 3 of the 4 multi-pass pipeline transitions,
   * matching `focusPull`'s own pair in shape. `pipeline-transition`/`linear-pipeline-transition`
   * deliberately deferred a tight bar ("belongs with the other deferred per-fixture bars" — that
   * commit's own words); these six do not, because DEBT-017 is exactly the axis this pass exists
   * to close, and shipping them on the loose 3.5% global would leave the same blind spot the
   * fixtures were added to remove — a future regression inside the bracket could move by nearly a
   * full percent and still read green.
   *
   * Measured, reproducible across 3 independent runs (byte-identical pixel counts every time — two
   * scoped to just these six fixtures, one inside the full 82-fixture sweep):
   *
   *     liquid-morph-transition          0.000% (5/2073600)
   *     linear-liquid-morph-transition   0.000% (4/2073600)
   *     portal-transition                0.000% (6/2073600)
   *     linear-portal-transition         0.092% (1899/2073600)   <- the outlier, see below
   *     motion-smear-transition          0.000% (0/2073600)
   *     linear-motion-smear-transition   0.001% (11/2073600)
   *
   * All six get the same 0.005 tier as their `flarex-*`/`flarex-tracked-mask-*` siblings rather than
   * six bespoke values — one tier for "the multi-pass transition family" is easier for the next
   * reader to reason about than a different number per fixture, and every reading here has real
   * margin under it. `linear-portal-transition` is the tightest fit at ~5.4x headroom (0.092% measured
   * against a 0.5% bar) — still 7x tighter than the global 3.5% budget, and unsurprising once you
   * read why: `portal`'s pipeline is the only one of the four whose intermediate stages ADD light
   * (`additive-mix`) rather than only blending it, so its linear/display divergence is the largest of
   * the family by construction, not by flake — three runs reading the identical 1899 differing pixels
   * is the evidence it is a real, stable, cross-renderer noise floor rather than a race.
   */
  "liquid-morph-transition": 0.005,
  "linear-liquid-morph-transition": 0.005,
  "portal-transition": 0.005,
  "linear-portal-transition": 0.005,
  "motion-smear-transition": 0.005,
  "linear-motion-smear-transition": 0.005
};

function barFor(key: RenderComparisonFixtureKey): number {
  if (process.env.PIXEL_MAX_DIFF_RATIO) return maxDiffRatio;
  return fixtureMaxDiffRatio[key] ?? maxDiffRatio;
}

// Which render path the harness exercises (default: the unified WebGL path — the one this
// comparison was built to verify). `legacy` re-checks the pre-WebGL DOM path for regressions.
const rendererMode: "legacy" | "webgl" = process.env.RENDERER_MODE === "legacy" ? "legacy" : "webgl";

// Which fixtures to sweep. Default: all variants. Override with PIXEL_FIXTURES=plain-image,matte.
const fixtureKeys: RenderComparisonFixtureKey[] = (() => {
  const raw = process.env.PIXEL_FIXTURES;
  if (!raw) return renderComparisonFixtureKeys;
  const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const valid = requested.filter((value): value is RenderComparisonFixtureKey =>
    renderComparisonFixtureKeys.includes(value as RenderComparisonFixtureKey)
  );
  if (!valid.length) throw new Error(`PIXEL_FIXTURES had no known fixtures. Known: ${renderComparisonFixtureKeys.join(", ")}`);
  return valid;
})();

interface FixtureResult {
  fixture: RenderComparisonFixtureKey;
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  renderFramePath: string;
  previewFramePath: string;
  diffFramePath: string;
}

async function main() {
  // Leftover Playwright trees corrupt this gate — see browser-preflight.ts. MUST run here, at
  // process start: this gate also drives Remotion's own browser, and a preflight sitting at a
  // launch site would classify that live browser as a leftover and kill it mid-render.
  assertQuietBrowserMachine({ label: "render:compare:pixels" });

  fs.mkdirSync(artifactDir, { recursive: true });
  console.log(`Render path under test: rendererMode=${rendererMode}`);
  console.log(`Fixtures: ${fixtureKeys.join(", ")}`);

  // Render every Remotion still up front (each blocks on its own WebGL frame), then spin one
  // vite server to capture all web-preview frames, then diff each pair.
  const stills = new Map<RenderComparisonFixtureKey, string>();
  for (const key of fixtureKeys) {
    const fixture = createRenderComparisonFixture(key);
    assert.ok(fixture.graph.composition, `Fixture "${key}" must include a composition.`);
    const manifest = buildRenderManifest({
      projectId: fixture.graph.projectId,
      graph: fixture.graph,
      assets: fixture.assets,
      quality: "final",
      createdAt: new Date(0).toISOString()
    });
    const frame = Math.round(renderComparisonFrameSeconds * manifest.output.fps);
    const renderFramePath = path.join(artifactDir, `remotion-${key}.png`);
    await renderManifestStill({ manifest, frame, outputLocation: renderFramePath, rendererMode });
    stills.set(key, renderFramePath);
  }

  const port = await getFreePort();
  const vite = startWebServer(port);
  const previews = new Map<RenderComparisonFixtureKey, string>();
  try {
    const baseUrl = `http://127.0.0.1:${port}/editor/__preview-fixture`;
    await waitForServer(baseUrl);
    for (const key of fixtureKeys) {
      // PIXEL_URL_EXTRA appends raw query params to the fixture URL, which is how a runtime FLAG arm
      // gets measured: every kernel flag resolves query-param first (`readKernelFlag`), so
      // `PIXEL_URL_EXTRA=kernelCoherenceUnified=1` runs the gate against the flag-on path without
      // touching the default the gate otherwise measures. Needed because a slice shipped behind a
      // default-off flag is otherwise INERT here — an A/B of it compares two identical code paths and
      // reports a reassuring null result about a change it never executed.
      const extra = process.env.PIXEL_URL_EXTRA ? `&${process.env.PIXEL_URL_EXTRA}` : "";
      const url = `${baseUrl}?fixture=${encodeURIComponent(key)}&rendererMode=${rendererMode}${extra}`;
      const previewFramePath = path.join(artifactDir, `web-preview-${key}.png`);
      const readiness = await capturePreviewFrame(url, previewFramePath, key);
      if (readiness) readinessObservations.push({ fixture: key, ...readiness });
      previews.set(key, previewFramePath);
    }
  } finally {
    await stopProcess(vite);
  }

  const results: FixtureResult[] = [];
  const failures: string[] = [];
  for (const key of fixtureKeys) {
    const renderFramePath = stills.get(key)!;
    const previewFramePath = previews.get(key)!;
    const diffFramePath = path.join(artifactDir, `diff-${key}.png`);
    const bar = barFor(key);
    const summary = comparePngs(renderFramePath, previewFramePath, diffFramePath, bar);
    results.push({ fixture: key, renderFramePath, previewFramePath, diffFramePath, ...summary });
    const pct = (summary.diffRatio * 100).toFixed(3);
    console.log(`[${key}] diff ${pct}% (${summary.diffPixels}/${summary.totalPixels}) → ${diffFramePath}`);
    if (summary.diffRatio > bar) {
      failures.push(`${key}: ${pct}% > ${(bar * 100).toFixed(3)}%`);
    }
  }

  // MERGE, don't replace. `PIXEL_FIXTURES=<one>` used to rewrite the summary with only the fixture it
  // ran, silently discarding the other 52 entries — a scoped run is a narrower question about the
  // same sweep, not a new sweep. Entries this run re-measured win; entries it did not touch survive.
  // A `rendererMode` change DOES invalidate the rest, since the old results describe a different
  // render path, so that case starts clean.
  const previous = readPreviousResults();
  const merged = new Map<string, FixtureResult>();
  for (const result of previous) merged.set(result.fixture, result);
  for (const result of results) merged.set(result.fixture, result);
  const mergedResults = [...merged.values()];

  fs.writeFileSync(
    diffSummaryPath,
    `${JSON.stringify(
      { rendererMode, maxDiffRatio, threshold: diffThreshold, results: mergedResults },
      null,
      2
    )}\n`
  );

  // Printed BEFORE the throw: a failing run is the one whose readiness reading matters, and a report
  // that only appears on success would systematically exclude every case it exists to explain.
  if (observeReadiness && readinessObservations.length) {
    const outcomeOf = new Map(results.map((r) => [r.fixture, r.diffRatio > barFor(r.fixture) ? "FAIL" : "pass"]));
    console.log("\n── readiness observation (PIXEL_READY_OBSERVE=1, capture timing UNCHANGED) ──");
    console.log("fixture                        gate   settled@capture  firstSettled  afterCapture  composites  participants  notReady  fallback cause");
    for (const o of readinessObservations) {
      const settled = o.ledgerPresent ? (o.settledAtCapture ? "yes" : o.neverSettled ? "NEVER" : "no") : "no-ledger";
      console.log(
        `${o.fixture.padEnd(30)} ${(outcomeOf.get(o.fixture) ?? "?").padEnd(6)} ${settled.padEnd(15)} ` +
          `${(o.firstSettledAtMs === null ? "-" : `${Math.round(o.firstSettledAtMs)}ms`).padEnd(13)} ` +
          `${(o.settledAfterMs === null ? "-" : `+${o.settledAfterMs}ms`).padEnd(13)} ` +
          `${String(o.composites).padEnd(11)} ${String(o.participants).padEnd(13)} ${String(o.notReady).padEnd(9)} ${o.degradation}`
      );
    }
    // Appended, not overwritten: choosing a bound needs a distribution across runs, and one run is
    // one sample of a race.
    fs.appendFileSync(
      path.join(artifactDir, "readiness-observations.jsonl"),
      `${readinessObservations
        .map((o) => JSON.stringify({ at: new Date().toISOString(), gate: outcomeOf.get(o.fixture) ?? "?", ...o }))
        .join("\n")}\n`
    );
  }

  if (failures.length) {
    throw new Error(`Pixel comparison failed for ${failures.length} fixture(s):\n  ${failures.join("\n  ")}`);
  }

  console.log(`Pixel comparison passed for all ${results.length} fixture(s).`);
}

function startWebServer(port: number) {
  // shell:true so Windows resolves `pnpm` → `pnpm.cmd`. Bare `spawn("pnpm")` is ENOENT, and spawning
  // `pnpm.cmd` directly is EINVAL on modern Node/Windows (CVE-2024-27980 hardening) — a shell is
  // required for `.cmd`. The args are static (no interpolation), so shell:true is safe here despite
  // the DEP0190 notice.
  const child = spawn("pnpm", ["--dir", path.join(repoRoot, "apps/web"), "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: repoRoot,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true
  });

  child.stdout.on("data", (data) => process.stdout.write(`[web] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[web] ${data}`));

  return child;
}

/**
 * READINESS OBSERVATION (default OFF, `PIXEL_READY_OBSERVE=1`) — measuring the capture race before
 * changing anything about it.
 *
 * The 250 ms sleep below is the gate's only wait for GPU output, and `flarex-generators` fails at
 * 86.895% in ~40% of runs (25-pair interleaved sweep, 2026-08-03: HEAD 10/25, ADR-012 10/25 — the
 * fixture is flaky at HEAD, which is what cleared the implementation). 86.895% is the documented
 * signature of a blank capture. This mode tests that explanation and sizes its fix WITHOUT touching
 * capture timing, so the numbers describe the gate as it actually ships:
 *
 *   - `atCapture` is read immediately BEFORE the screenshot. If the blank-capture story is right,
 *     failing runs are the ones whose frame was not settled at that instant. That is the causal test,
 *     and it is only trustworthy because nothing here moves the screenshot.
 *   - `settledAfterMs` keeps polling AFTER the screenshot, so a run that missed still reports when it
 *     WOULD have been ready. That is the latency distribution the eventual bound gets chosen from —
 *     p50/p95/max, not one maximum, since a bound picked off a single worst run encodes that run.
 *
 * SETTLED is the present ledger's own definition, not a new one invented here: a composite that
 * presented with no stale source AND nothing not-ready. The stricter `notReady === 0` matters —
 * `outcome: "coherent"` alone only means no source disagreed about the MOMENT, and a generator whose
 * raster has not landed is not stale, it is absent. Absence is exactly this fixture's failure.
 */
const observeReadiness = process.env.PIXEL_READY_OBSERVE === "1";
const READY_POLL_BUDGET_MS = 10_000;

interface ReadinessObservation {
  fixture: RenderComparisonFixtureKey;
  /** Composites recorded by capture time. 0 means the ledger was empty — nothing had presented. */
  composites: number;
  /** Was a settled composite already on record when the screenshot was taken? */
  settledAtCapture: boolean;
  /** Page-relative ms of the first settled composite, or null if none had happened by capture. */
  firstSettledAtMs: number | null;
  /** Ms spent polling AFTER capture before a settled composite appeared. Null = it already had. */
  settledAfterMs: number | null;
  /** True when the budget expired with no settled composite ever — the case a fatal wait must not hang on. */
  neverSettled: boolean;
  /** Media sources in the last recorded composite. 0 is legitimate (a text/shape-only fixture). */
  participants: number;
  /** Layers with no content in the last recorded composite. Non-zero at capture = a blank region. */
  notReady: number;
  /** False when the page published no ledger at all — legacy renderer, or diagnostics off. */
  ledgerPresent: boolean;
  /** Flarex fallback causes seen this capture, e.g. `host-substituted:no-loader=12`. */
  degradation: string;
}

const readinessObservations: ReadinessObservation[] = [];

/**
 * Read the ledger's view of readiness plus the page clock. Returns null when the page publishes no
 * ledger. Only ever called AFTER the screenshot — see the note at the capture site.
 */
async function readLedgerWithClock(page: import("playwright").Page) {
  return page.evaluate(() => {
    const ledger = (globalThis as { __rfPresentLedger?: { rows: (limit?: number) => unknown[] } })
      .__rfPresentLedger;
    if (!ledger) return null;
    const rows = ledger.rows(2048) as {
      atMs: number;
      outcome: string;
      participants: number;
      stale: number;
      notReady: number;
    }[];
    const settled = rows.find((row) => row.outcome === "coherent" && row.notReady === 0);
    const last = rows[rows.length - 1];
    // WHY a node fell back, not just that it did. `degrade()` runs BEFORE S4.5's
    // `allowHostSubstitution === false` early return, so the reasons are still recorded on a flag-on
    // run — which is what makes this the decisive reading: it separates `host-substituted:pending`
    // (a node's own pixels have not arrived — the I-27 violation S4.5 exists to delete) from
    // `:no-loader` / `:no-resolver` (the host clip IS this node's source, and drawing it is correct).
    const degradation = (
      globalThis as { __rfFlarexDegradation?: { byReason: { reason: string; count: number }[] } }
    ).__rfFlarexDegradation;
    return {
      nowMs: performance.now(),
      composites: rows.length,
      firstSettledAtMs: settled ? settled.atMs : null,
      participants: last?.participants ?? 0,
      notReady: last?.notReady ?? 0,
      degradation: (degradation?.byReason ?? [])
        .filter((row) => row.reason.startsWith("host-substituted:") || row.reason.startsWith("source-"))
        .map((row) => `${row.reason}=${row.count}`)
        .join(" "),
    };
  });
}

/**
 * READINESS GATE (2026-08-13) — replaces a blind sleep with an assertion, for the one fixture the
 * fixed 250ms floor below was never sized for.
 *
 * `flarex-generators` settles 5.9-13s into a fresh page load — its procedural noise genuinely takes
 * that long to produce a first coherent frame — while every other fixture in the sweep settles
 * within the fonts/images wait above, well under a second. A fixed sleep sized for the fast
 * fixtures RACES the slow one: `PIXEL_READY_OBSERVE=1` (see the instrument below) measured a 40%
 * failure rate for this fixture in a 25-run interleaved sweep at HEAD (2026-08-03) — every failing
 * run reading `notReady:2`/`neverSettled` at the 250ms mark, every passing run reading a real settle
 * between 5.9s and 13s later. The fixture was not flaky; the wait was blind to what it was waiting
 * for, and whether a run passed depended on ambient page-load cost (vite warmth, browser startup
 * jitter) that happened to already exceed 250ms, not on anything about the fixture itself.
 *
 * So: poll the SAME ledger the diagnostic instrument reads, for the SAME "settled" condition (a
 * composite on record with `notReady === 0` — every participating source has delivered a frame),
 * bounded at `CAPTURE_READY_POLL_BUDGET_MS` — comfortably above every settle time measured on this
 * fixture, including the cold-start outlier. This is the actual defect's readiness signal, not a
 * proxy for it, and it costs ordinary fixtures nothing: they are already settled by the time this
 * runs (the fonts/images wait above already exceeds their settle time), so the first poll returns
 * immediately.
 *
 * `ledgerPresent === false` means the page never published a ledger at all — `RENDERER_MODE=legacy`
 * (the pre-WebGL DOM path never calls `notePresent`/`noteHeld`, see `ScenePreviewCanvas.tsx`) or
 * diagnostics explicitly disabled via `?kernelDiagnostics=0`. There is nothing observable to assert
 * readiness FROM in that case — logged once and returned immediately, rather than silently burning
 * the whole poll budget on an instrument that will never report on this run.
 */
const CAPTURE_READY_POLL_BUDGET_MS = 10_000;

async function awaitCaptureReadiness(page: import("playwright").Page, fixture: RenderComparisonFixtureKey): Promise<void> {
  const pollStart = Date.now();
  while (Date.now() - pollStart < CAPTURE_READY_POLL_BUDGET_MS) {
    const reading = await readLedgerWithClock(page);
    if (!reading) {
      console.log(
        `[${fixture}] readiness gate: no __rfPresentLedger on this page (legacy renderer or ` +
          `diagnostics off) — nothing observable to wait on, falling back to the fixed pre-capture wait.`
      );
      return;
    }
    if (reading.firstSettledAtMs !== null) return; // A settled composite is on record. Ready.
    await page.waitForTimeout(50);
  }
  console.log(
    `[${fixture}] readiness gate: TIMED OUT after ${CAPTURE_READY_POLL_BUDGET_MS}ms with no settled ` +
      `composite on record — capturing anyway. The diff comparison below is expected to fail loudly; ` +
      `this line is what makes that failure attributable instead of mysterious.`
  );
}

async function capturePreviewFrame(url: string, outputPath: string, fixture: RenderComparisonFixtureKey): Promise<Omit<ReadinessObservation, "fixture"> | null> {
  // PIXEL_BROWSER_CHANNEL lets a dev without the Playwright-managed Chromium fall back to an
  // installed channel ("msedge"/"chrome"); default uses the bundled Chromium.
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { width: 1200, height: 2100 }
    });
    // COLD-CACHE FIRST RUN (measured 2026-08-09): on a fresh clone or a new worktree, vite's dep
    // pre-bundle happens inside this first navigation and can exceed the 30s `networkidle` budget — the
    // gate then fails at fixture 1 with `page.goto: Timeout 30000ms exceeded`. RE-RUN BEFORE
    // INVESTIGATING; the second run is warm and passes. Verified by holding env fixed and varying only
    // `node_modules/.vite`: cold failed, warm passed 53/53 with byte-identical per-fixture numbers.
    // The timeout is deliberately NOT raised — nobody has measured what the right budget is, and that
    // would be a behaviour change to a gate.
    await page.goto(url, { waitUntil: "networkidle" });
    await page.locator("[data-render-fixture='ready']").waitFor({ state: "visible" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map((image) =>
          image.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                image.addEventListener("load", () => resolve(), { once: true });
                image.addEventListener("error", () => resolve(), { once: true });
              })
        )
      );
    });

    // Wait for CONTENT readiness first — see awaitCaptureReadiness's own header. This is what
    // replaces the old blind sleep for flarex-generators; it is a no-op in elapsed time for every
    // fixture that was already settled by the fonts/images wait above.
    await awaitCaptureReadiness(page, fixture);

    // THEN give the scene compositor's rAF a couple frames to paint its first result (same settle its
    // sibling gate scene-compositor-compare.ts always had). This is a DIFFERENT race from the one
    // above — content can be logically "settled" a frame or two before the GPU has actually presented
    // it — and without this the screenshot can still race that GPU present and randomly capture a
    // BLACK canvas (~88% diff on arbitrary fixtures per run — verified 2026-07-07: failing web
    // captures meanLuma≈0 vs remotion≈110, differing fixture sets across identical-code runs).
    // Capture-sync only; thresholds and rendering are untouched.
    await page.waitForTimeout(250);

    // NOTHING may touch the page between the sleep and the screenshot. The first version of this
    // instrument read the ledger here, and `page.evaluate` is a round-trip — it inserted delay at
    // exactly the point where timing decides the outcome, and produced 6 passes in 6 runs against a
    // measured 40% failure rate (p ~ 0.047). That is programme risk R1, the observer effect, and an
    // instrument that widens the race it is measuring reports on a gate that does not ship.
    //
    // So: capture first, ask afterwards, and RECONSTRUCT the capture instant from timestamps. The page
    // clock at the read is `nowMs`; subtracting the Node-side elapsed since just before the screenshot
    // places the shutter on the page's own timeline without ever having spoken to the page.
    const beforeShot = Date.now();
    await page.locator(".preview-composition-space").screenshot({
      animations: "disabled",
      caret: "hide",
      omitBackground: false,
      path: outputPath
    });

    if (!observeReadiness) return null;
    const afterShot = await readLedgerWithClock(page);
    const atCapture = afterShot
      ? {
          ...afterShot,
          // Page-clock instant of the shutter. Rounded off by however long the screenshot took, which
          // biases toward calling a marginal frame "settled at capture" — the conservative direction,
          // since it under-reports the very failures this is looking for.
          captureAtPageMs: afterShot.nowMs - (Date.now() - beforeShot),
        }
      : null;

    if (!atCapture) {
      // No ledger: legacy renderer mode, or diagnostics disabled. Reported rather than inferred —
      // an absent instrument must not read as a healthy zero.
      return {
        composites: 0, settledAtCapture: false, firstSettledAtMs: null, settledAfterMs: null,
        neverSettled: false, participants: 0, notReady: 0, ledgerPresent: false, degradation: "",
      };
    }

    // Keep watching AFTER the capture. A run that captured early still tells us when it settled, and
    // that is the only way to size the bound from runs that FAILED rather than only from ones that
    // happened to win the race.
    // Settled AT CAPTURE is a timestamp question, not an ordering one: the first settled composite
    // must predate the shutter. Reading the ledger after the fact would otherwise credit the capture
    // with a composite that only landed while we were asking about it.
    const settledAtCapture =
      atCapture.firstSettledAtMs !== null && atCapture.firstSettledAtMs <= atCapture.captureAtPageMs;

    let settledAfterMs: number | null = null;
    let firstSettledAtMs = atCapture.firstSettledAtMs;
    let latest: {
      composites: number; firstSettledAtMs: number | null; participants: number; notReady: number;
    } = atCapture;
    if (firstSettledAtMs === null) {
      const pollStart = Date.now();
      while (Date.now() - pollStart < READY_POLL_BUDGET_MS) {
        await page.waitForTimeout(50);
        const now = await readLedgerWithClock(page);
        if (!now) break;
        latest = now;
        if (now.firstSettledAtMs !== null) {
          firstSettledAtMs = now.firstSettledAtMs;
          settledAfterMs = Date.now() - pollStart;
          break;
        }
      }
    }

    return {
      composites: latest.composites,
      settledAtCapture,
      firstSettledAtMs,
      // How far the shutter MISSED by, when it did. This is the number the bound gets sized from.
      settledAfterMs:
        settledAfterMs ??
        (firstSettledAtMs !== null && !settledAtCapture
          ? Math.round(firstSettledAtMs - atCapture.captureAtPageMs)
          : null),
      neverSettled: firstSettledAtMs === null,
      participants: latest.participants,
      notReady: latest.notReady,
      ledgerPresent: true,
      degradation: atCapture.degradation,
    };
  } finally {
    await browser.close();
  }
}

// Reads the results of the previous sweep so a scoped run can merge into them rather than replace
// them. Any unreadable/malformed/foreign-rendererMode summary yields [] — a broken file must not fail
// the gate, it just means this run starts from nothing.
function readPreviousResults(): FixtureResult[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(diffSummaryPath, "utf8")) as {
      rendererMode?: string;
      results?: FixtureResult[];
    };
    if (parsed.rendererMode !== rendererMode) return [];
    if (!Array.isArray(parsed.results)) return [];
    return parsed.results.filter((result) => typeof result?.fixture === "string");
  } catch {
    return [];
  }
}

function comparePngs(renderPath: string, previewPath: string, diffPath: string, bar: number) {
  const render = PNG.sync.read(fs.readFileSync(renderPath));
  const preview = PNG.sync.read(fs.readFileSync(previewPath));

  assert.equal(preview.width, render.width, "Preview width must match Remotion render width.");
  assert.equal(preview.height, render.height, "Preview height must match Remotion render height.");

  const diff = new PNG({ width: render.width, height: render.height });
  const diffPixels = pixelmatch(render.data, preview.data, diff.data, render.width, render.height, {
    threshold: diffThreshold
  });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = render.width * render.height;
  return {
    width: render.width,
    height: render.height,
    frameSeconds: renderComparisonFrameSeconds,
    threshold: diffThreshold,
    // The bar this fixture was actually judged against, not the global default — otherwise the
    // summary reports a number the gate never used.
    maxDiffRatio: bar,
    diffPixels,
    totalPixels,
    diffRatio: diffPixels / totalPixels
  };
}

async function getFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not find a free port."));
      });
    });
  });
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for web server. Last error: ${String(lastError)}`);
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) {
    return;
  }

  // On Windows the vite server is spawned via `shell:true`, so `child` is the cmd wrapper — SIGTERM to it
  // leaves the real vite node process (and its ChildProcess handle) alive, which keeps this process's event
  // loop open after `main()` resolves (the teardown hang). `taskkill /T /F` kills the whole tree. Mirrors the
  // sibling export gates (export-worker-scene.ts / export-scene-compare.ts).
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      const timeout = setTimeout(resolve, 5_000);
      killer.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      killer.once("error", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

// Exit explicitly once the verdict is printed. The render + diff work is done by then, so a lingering handle
// (e.g. a vite child that outlived teardown) must not keep the process alive — `stopProcess` already tore the
// server down. Mirrors export-worker-scene.ts.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
