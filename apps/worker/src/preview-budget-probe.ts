/**
 * Preview FRAME BUDGET probe — the soak reading that only a human could produce, scripted.
 *
 * WHY. The ADR-012 Phase 3 soak turned up one defect no headless gate could see: with
 * `?kernelProxySource=1` the picture was correct (no flashes, no blacks, every pixel gate green) and the
 * preview fell from ~75fps to 48-59 with intermittent lag. Every correctness gate in this repo passes on
 * that build, because the defect was never in the output — it was in the cost of producing it.
 *
 * That reading was obtained by a person opening the editor, playing, and reading the HUD. Doing it by
 * hand cost hours and produced arms that were not comparable: different projects, unequal durations, one
 * run missing its telemetry snippet. None of that is inherent — `__rfFrameStats` is the same object the
 * HUD renders, and engine flags are URL parameters, so the controlled A/B is two `page.goto` calls.
 *
 * WHAT IT REPORTS, per arm: fps / mean frame ms / composite CPU ms / dropped-frame counts from
 * `__rfFrameStats`, alongside `__rfWcPool` (decoder sessions, retention hits) and `__rfKernelState`
 * (declared / demoted / suppressed sources, decoder ledger, resource scopes). Frame budget and resource
 * ledger in one table, because "it got slower" and "it is holding more sessions" are the two halves of
 * every finding this programme has produced.
 *
 * This is a MEASUREMENT harness, not a pass/fail gate. Absolute numbers are machine-specific; the arms
 * are comparable to each other on one box in one run, which is the only comparison anyone should make.
 *
 * A blank project seeded with one clip has NO Flarex comp, so `kernelProxySource` has nothing to demote
 * and both arms should read the same — that is the harness's own null result, and worth having: an arm
 * difference on a comp-free project would mean the flag costs something unconditionally. To measure the
 * demotion path itself, point this at a project that HAS a proxied comp:
 *
 *   PROBE_PROJECT=http://localhost:5173/editor/<id> PIXEL_BROWSER_CHANNEL=chrome \
 *     pnpm --filter @orreris/worker preview:budget
 *
 * Local projects live in the browser profile, so a saved profile is needed to see one again:
 *   PROBE_PROFILE=<dir>   reuse/persist a Chrome profile between runs
 *
 * Run (dev server must be up):
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker preview:budget
 *   PROBE_SECONDS=20 ...   (default 12 of playback per arm)
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  addAssetSourceMediaIn,
  addMediaInBoundTo,
  importAssets,
  cutClipAtFraction,
  buildFlarexProxyFixture,
  awaitWebCodecsEngaged,
  defaultClipPath,
  reachEditor,
  reopenWithFlags,
  seekBeforeCut,
  EDITOR_BASE,
} from "./browser/editor-session";

const SECONDS = Number(process.env.PROBE_SECONDS ?? 12);

/**
 * How many DISTINCT asset-source MediaIns the fixture binds. Default 1 keeps every existing arm
 * comparison byte-identical.
 *
 * ADR-013 Phase 0 / M0 needs more than one, and the reason is the vacuity rule. The one-MediaIn fixture
 * opens two sessions against a four-slot budget, so `capMisses` is 0 because nothing was ever contended
 * — indistinguishable from `capMisses` 0 because the path is clean. M0 measures whether an instrument on
 * the CONTENTION path perturbs it; a run with no contention cannot answer that in either direction.
 *
 * The files must DIFFER. A decoder slot is keyed by URL, so N copies of one asset are N doors onto one
 * session: they can never exceed the budget and never be denied. See `importAssets`.
 */
const SOURCES = Math.max(1, Number(process.env.PROBE_SOURCES ?? 1));

/**
 * Distinct seed files, smallest first. Mirrors `source-admission-probe`'s helper — admission and the
 * observer effect need the same raw material, and `defaultClipPath` returns exactly one clip.
 */
function seedClips(count: number): string[] {
  const first = defaultClipPath(SECONDS + 8);
  const dir = path.dirname(first);
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  const picked = [first, ...files.filter((f) => f !== first)].slice(0, count);
  if (picked.length < count) {
    throw new Error(`need ${count} distinct clips, found ${picked.length} in ${dir}`);
  }
  return picked;
}
/** Discarded before sampling: the first second of playback is decoder warmup, not steady state. */
const WARMUP_MS = 1_500;

/** The arms. Equal durations, same project, same page — the three things the hand-run soak could not hold. */
const ARM_SETS: Record<string, { name: string; flags: string }[]> = {
  // Default: S3.5's open C1 question — what demotion costs, if anything.
  demotion: [
    { name: "baseline (proxy source OFF)", flags: "kernelProxySource=0" },
    { name: "S3.5 demotion (proxy source ON)", flags: "kernelProxySource=1" },
  ],
  /**
   * S4.7, post-S7.2. ONE arm, because there is no longer a second configuration to compare against:
   * `kernelSessionSatisfaction` and `kernelProxySource` are deleted and satisfaction is simply how the
   * runtime behaves. Keeping the old pair would have left two arms whose flag strings name nothing,
   * reporting a beautifully reproducible null result about one configuration measured twice.
   *
   * WHAT IS LOST, stated because it matters: the flag-off arm was this soak's vacuity guard — it
   * reproduced the harm every run, which is what proved the fixture could still fail. With the old path
   * deleted that control is gone, so `blindSplits > 0` becomes the guard: it says the blind-share path
   * was actually reached this run. A run reporting `detaches 0 · blindSplits 0` is NOT a pass, it is a
   * fixture that never got there, and must be read as void.
   */
  satisfaction: [{ name: "shipping configuration", flags: "wcDecode=1" }],
  /**
   * ADR-013 Phase 0 / **M0 variance baseline**. Two IDENTICAL arms.
   *
   * Run this BEFORE `observer`. M0's decision rule compares the on/off pair against a threshold, and a
   * threshold of zero assumes `capMisses` is deterministic — which is an assumption, not a measurement.
   * A contention counter on a machine with real timing variance need not repeat. If it does not, the
   * strict bar fails spuriously, a sound instrument gets refactored, and all of Stage 1 is blocked by
   * a number that was never stable.
   *
   * Two identical arms measure exactly that. The output IS the variance *V*. A null result here — both
   * arms identical — is the strong outcome and is worth recording as such: a deterministic `capMisses`
   * makes every later contention comparison in this programme sharper.
   */
  "observer-variance": [
    { name: "off arm A (variance baseline)", flags: "kernelDiagnostics=0" },
    { name: "off arm B (variance baseline)", flags: "kernelDiagnostics=0" },
  ],
  /**
   * ADR-013 Phase 0 / **M0 proper** — the observer effect in the ON direction.
   *
   * R1 requires an instrument to cost nothing when OFF, and that half is verified structurally. But
   * Stage 1 runs with the instruments ON, and `admission.scored` copies a ring on the per-acquire path.
   * Verifying only the off direction proves the shipped runtime is unharmed and merely ASSUMES the
   * measured one is — on the exact path whose contention every Stage 1 number describes.
   *
   * `capMisses` is the load-bearing comparand because it is the UNCONDITIONAL counter. `admissionDenials`
   * is counted inside the diagnostics guard and reads 0 in the off arm by construction, so comparing it
   * across these two arms would manufacture the effect this measurement exists to detect.
   */
  observer: [
    { name: "instruments OFF", flags: "kernelDiagnostics=0" },
    { name: "instruments ON", flags: "kernelDiagnostics=1" },
  ],
};
// Arm ORDER is a confound: the first arm pays every one-time cost (shader compile, proxy warm, GPU
// clock ramp) and the second inherits a warmed machine. `PROBE_REVERSE=1` runs the same pair backwards,
// so a finding that survives both orders is the flag and one that flips is the ordering.
const ARMS = (() => {
  const set = ARM_SETS[process.env.PROBE_ARMS ?? "demotion"] ?? ARM_SETS.demotion!;
  // PROBE_EXTRA_FLAGS is appended to EVERY arm, so it varies the environment both arms share rather
  // than the variable under test. `wcDecode=1` is the expected use: S4.7's subsystem does not exist
  // on the element path, and an arm pair measured with it off compares two absences.
  const extra = process.env.PROBE_EXTRA_FLAGS;
  const withExtra = extra ? set.map((arm) => ({ ...arm, flags: `${arm.flags}&${extra}` })) : set;
  return process.env.PROBE_REVERSE === "1" ? [...withExtra].reverse() : withExtra;
})();

interface Sample {
  /** Compositor repaint rate — runs at display refresh and will happily redraw an unchanged frame. */
  fps: number;
  /**
   * NEW video frames presented per second. Sampled alongside `fps` because they answer different
   * questions and this repo has already confused them once: a demoted loader that stopped pulling
   * SHOULD drop `mediaFps` for its own sources while leaving the compositor's `fps` alone, so reporting
   * only one of the two would make the intended effect indistinguishable from the defect.
   */
  mediaFps: number;
  avgFrameMs: number;
  maxFrameMs: number;
  drawMs: number;
  droppedRatio: number;
  severeCount: number;
  renderScale: number;
  /** Served times observed this sample, from any decode path. See the note at the sampling site. */
  served: number[];
  /**
   * Per-source supply state this sample — the whole point of the v34 follow-up.
   *
   * `mediaFps` swung 45.7 / 27.1 / 8.0 / 1.7 across four identical runs of one project while the
   * compositor held 60-70fps throughout: decode collapsed 25× run to run and the frame-budget table
   * could not say why, because it kept only `served` and discarded every field beside it. These are
   * already published per composite — decode path, whether the source has a frame at all, and the
   * reason it does not — so the answer was in the page the whole time and not in the report.
   */
  sources: SourceSample[];
}

interface SourceSample {
  id: string;
  asset: string;
  /** `element` vs `wc-hw` / `wc-sw`. An ingest proxy flips this, and it is worth a decode-rate order. */
  decode: string;
  /** `ok` | `stale` | `AWAITING` — AWAITING means no frame at all, which is not slowness but absence. */
  state: string;
  /** Whose fault the absence is (`awaitReason`). Null when there is nothing to explain. */
  why: string | null;
  /** `null` = this build does not publish the field at all. See the note at the sampling site. */
  wcProvider: boolean | null;
  wcBusy: boolean | null;
  /**
   * The two fields that MOVE every composite, carried so the liveness test has something to test.
   *
   * Without them the freshness fingerprint was built from `decode`/`state`/`why`/`wcProvider` alone —
   * all of which a healthy source holds constant for seconds at a time — so a source decoding at 30fps
   * reported `graded 4/36`. The fix for a instrument that counted corpses cannot itself be blind to the
   * living: `served` advances with every delivered frame and `staleMs` is recomputed against the moving
   * playhead, so a row being written is a row where at least one of these two differs.
   */
  served: number | null;
  staleMs: number | null;
}

interface ArmResult {
  name: string;
  samples: Sample[];
  pool: Record<string, number> | null;
  kernel: unknown;
  degradation: unknown;
  borrow?: {
    grants?: { grounds?: string; incumbentTimes?: number[]; incumbentCount?: number; joinerPriority?: string; incumbentPriority?: string }[];
    refusals?: { reason?: string; gapSeconds?: number | null; toleranceSeconds?: number }[];
    misses?: number;
    blindSplits?: number;
    detached?: {
      reason?: string;
      gapSecondsAtApproval?: number | null;
      joinerTimeAtApproval?: number | null;
      servedAtApproval?: number | null;
      requestedTimesAtDetach?: number[];
    }[];
  } | null;
  error?: string;
}

// Targeted by `title`, not by role name: the transport button's content is an icon, so its computed
// accessible name is the glyph and `getByRole("button", { name: /play/i })` silently matches nothing —
// which is how the first run of this probe reported "transport never advanced" for both arms while the
// editor was in fact fine. The title is also the toggle's state (`Play (Space)` / `Pause (Space)`), so
// it doubles as the assertion that the click landed.
// Scoped to `.viewer-controls`: `button[title^="Play"]` matches TWO controls — the viewer transport and
// the inspector's reverse-play — and DOM order puts the wrong one first, so an unscoped `.first()` clicks
// a control that does nothing here and reports "the transport never advanced".
const PLAY = '.viewer-controls button[title^="Play"]';
const PAUSE = '.viewer-controls button[title^="Pause"]';

async function play(page: Page): Promise<boolean> {
  const button = page.locator(PLAY).first();
  if (!(await button.count().catch(() => 0))) return false;
  await button.click().catch(() => undefined);
  // The toggle flipping to "Pause" is the only proof the transport actually started.
  return await page
    .locator(PAUSE)
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
}

async function pause(page: Page): Promise<void> {
  await page.locator(PAUSE).first().click({ timeout: 3_000 }).catch(() => undefined);
}

/**
 * Pin the playback resolution before measuring.
 *
 * Auto quality is a closed loop: it drops resolution when frames are dropped and recovers when smooth,
 * so it CHANGES THE WORKLOAD IN RESPONSE TO THE WORKLOAD. Left on, the first real run of this probe
 * settled one arm at 0.25 and the other at 0.5 and then compared their frame rates — 67.9 against 63.4,
 * a difference that is entirely the resolution and says nothing about the flag under test. An adaptive
 * controller in the measurement path is a confound, not a feature, and a fixed scale is the only way the
 * two arms are doing the same amount of work.
 *
 * Half is the pin: Full leaves no headroom for a regression to show up in, Quarter hides one.
 */
async function pinRenderScale(page: Page): Promise<void> {
  await page
    .locator('.viewer-controls button[title^="Half playback resolution"]')
    .first()
    .click({ timeout: 5_000 })
    .catch(() => undefined);
  await page.waitForTimeout(300);
}

async function sampleArm(page: Page, name: string, seekLeadSeconds: number | null): Promise<ArmResult> {
  const samples: Sample[] = [];
  await pinRenderScale(page);
  // Park before the cut BEFORE playing. A reload resets the playhead to 0, so this belongs to the arm,
  // not to the fixture — and both arms have to start from the same place or the comparison is of two
  // different stretches of footage. Reported per arm for exactly that reason.
  if (seekLeadSeconds != null) {
    const seek = await seekBeforeCut(page, seekLeadSeconds);
    console.log(
      seek
        ? `  · parked at ${seek.parkedSeconds.toFixed(2)}s, ${(seek.cutSeconds - seek.parkedSeconds).toFixed(2)}s before the cut at ${seek.cutSeconds.toFixed(2)}s`
        : "  · SEEK FAILED — the run starts at 0 and will not visit the crossing"
    );
    if (!seek) {
      return { name, samples, pool: null, kernel: null, degradation: null, error: "could not park before the cut" };
    }
    // The crossing is a WINDOW, not a state: the shell mounts ~1.2s out and the borrow is over once the
    // cut passes. Waiting out the whole first clip would sample mostly ordinary playback and dilute it.
    await page.waitForTimeout(400);
  }
  if (!(await play(page))) {
    return {
      name,
      samples,
      pool: null,
      kernel: null,
      degradation: null,
      error: `transport did not start (no ${PLAY}, or it never flipped to Pause)`,
    };
  }
  await page.waitForTimeout(WARMUP_MS);

  let stoppedEarly = false;
  const startedAt = Date.now();
  const deadline = startedAt + SECONDS * 1_000;
  while (Date.now() < deadline) {
    // A dev-server HMR reload destroys the execution context mid-sample and used to kill the run with a
    // raw Playwright error. Editing source while a probe drives the page is operator error, but the probe
    // should report the arm as spoiled rather than lose the whole measurement to it.
    const snap = await page.evaluate(() => {
      const stats = (globalThis as Record<string, any>).__rfFrameStats;
      if (!stats) return null;
      return {
        fps: Number(stats.fps ?? 0),
        mediaFps: Number(stats.mediaFps ?? 0),
        avgFrameMs: Number(stats.avgFrameMs ?? 0),
        maxFrameMs: Number(stats.maxFrameMs ?? 0),
        drawMs: Number(stats.avgDrawMs ?? 0),
        droppedRatio: Number(stats.droppedRatio ?? 0),
        severeCount: Number(stats.severeCount ?? 0),
        renderScale: Number(stats.renderScale ?? 1),
        // Cross-path decode evidence. `mediaFps` comes from requestVideoFrameCallback, which is a
        // <video>-ELEMENT api — on the WebCodecs path there is no element and no rvfc, so it reads 0
        // while decoding perfectly well. Using it alone to decide "did anything decode?" made the
        // vacuity guard fire on healthy WC runs: the same class of instrument error it was built to
        // catch, pointed the other way. `__rfSourceMap[*].served` is S4.2's served time and is
        // published by BOTH paths, so a changing set of served times is decode evidence either way.
        served: Object.values(((globalThis as Record<string, any>).__rfSourceMap ?? {}) as Record<string, any>)
          .map((row) => (row && typeof row.served === "number" ? row.served : null))
          .filter((t): t is number => t != null),
        sources: Object.entries(((globalThis as Record<string, any>).__rfSourceMap ?? {}) as Record<string, any>).map(
          ([id, row]) => ({
            id,
            asset: String(row?.asset ?? "-"),
            decode: String(row?.decode ?? "-"),
            state: String(row?.state ?? "-"),
            why: row?.why == null ? null : String(row.why),
            // ABSENT is not FALSE. `wcProvider`/`wcBusy`/`why` are published by a diagnostics block
            // that is currently UNCOMMITTED work in `ScenePreviewCanvas.tsx`. Coercing a missing field
            // with `!!` turns "this build does not report it" into "the source never had a provider" —
            // and that reading is what the 2026-08-03 availability hypothesis was built on. If that work
            // is ever discarded or stashed, the probe would keep printing `wcProvider 0%` and it would
            // look exactly like a finding. Absent must be visible as absent.
            wcProvider: typeof row?.wcProvider === "boolean" ? row.wcProvider : null,
            wcBusy: typeof row?.wcBusy === "boolean" ? row.wcBusy : null,
            served: typeof row?.served === "number" ? row.served : null,
            staleMs: typeof row?.staleMs === "number" ? row.staleMs : null,
          })
        ),
      };
    }).catch((error: unknown) => {
      const message = String(error);
      if (/Execution context was destroyed|Target closed/.test(message)) return "navigated" as const;
      throw error;
    });
    if (snap === "navigated") {
      return {
        name,
        samples,
        pool: null,
        kernel: null,
        degradation: null,
        error: "the page navigated mid-arm (dev-server reload?) — this arm is spoiled",
      };
    }
    // Idle samples (fps 0) are not slow frames — they are the absence of frames, and averaging them in
    // would make a paused arm look catastrophic rather than absent.
    if (snap && snap.fps > 0) samples.push(snap);
    await page.waitForTimeout(250);

    // STOP WHEN THE TRANSPORT DOES. Playback that reaches the end of the timeline stops itself, and the
    // compositor keeps repainting the last frame at display rate — so `fps` stays healthy while nothing
    // decodes. Worse, `playbackRenderScale` is `isPlaying ? profile : 1`, so those idle samples arrive
    // labelled Full and mix a second resolution into an arm that was pinned to Half. That is what fired
    // the comparability guard on the first cut run: not the pin failing, the run outliving its material.
    if (!(await page.locator(PAUSE).first().count().catch(() => 0))) {
      stoppedEarly = true;
      break;
    }
  }

  const tail = await page.evaluate(() => ({
    pool: (globalThis as Record<string, any>).__rfWcPool ?? null,
    kernel: (globalThis as Record<string, any>).__rfKernelState ?? null,
    degradation: (globalThis as Record<string, any>).__rfFlarexDegradation ?? null,
    // S4.7 diagnosis: `shareDetaches` says a granted borrow diverged; only the ledger says WHICH grant
    // and on what grounds, and the two grounds have different corrections.
    borrow: (globalThis as Record<string, any>).__rfBorrowLedger ?? null,
  }));
  await pause(page);
  if (stoppedEarly) {
    console.log(
      `  · transport stopped itself after ${((Date.now() - startedAt) / 1000).toFixed(1)}s — the run outlived its material`
    );
  }
  return { name, samples, ...tail };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function report(result: ArmResult): void {
  console.log(`\n── ${result.name}`);
  if (result.error) {
    console.log(`   ERROR: ${result.error}`);
    return;
  }
  if (result.samples.length === 0) {
    console.log("   no frames sampled (transport never advanced)");
    return;
  }
  const fps = result.samples.map((s) => s.fps);
  const mediaFps = result.samples.map((s) => s.mediaFps);
  const frameMs = result.samples.map((s) => s.avgFrameMs);
  const drawMs = result.samples.map((s) => s.drawMs);
  const last = result.samples[result.samples.length - 1]!;
  console.log(
    `   fps       p50 ${percentile(fps, 50).toFixed(1)}   p05 ${percentile(fps, 5).toFixed(1)} (worst)   ` +
      `min ${Math.min(...fps).toFixed(1)}   samples ${result.samples.length}   renderScale ${last.renderScale}`
  );
  console.log(`   mediaFps  p50 ${percentile(mediaFps, 50).toFixed(1)}   p05 ${percentile(mediaFps, 5).toFixed(1)}`);
  console.log(`   frame ms  p50 ${percentile(frameMs, 50).toFixed(2)}   p95 ${percentile(frameMs, 95).toFixed(2)}   worst ${Math.max(...result.samples.map((s) => s.maxFrameMs)).toFixed(1)}`);
  console.log(`   draw ms   p50 ${percentile(drawMs, 50).toFixed(2)}   p95 ${percentile(drawMs, 95).toFixed(2)}`);
  console.log(
    `   dropped   ${(percentile(result.samples.map((s) => s.droppedRatio), 50) * 100).toFixed(1)}% of frames   ` +
      `severe ${Math.max(...result.samples.map((s) => s.severeCount))}`
  );
  // MEDIA SUPPLY, per source. `mediaFps` is one number for the whole scene, so a run where one source
  // decoded fine and another never started looks identical to a run where both limped. This breaks the
  // aggregate back into "which source, on which decode path, in what state, and why".
  const bySource = new Map<string, { asset: string; decode: Set<string>; state: Map<string, number>; why: Map<string, number>; provider: number; providerUnreported: number; busy: number; n: number; frozen: number }>();
  /**
   * LEFTOVER ROWS ARE NOT SAMPLES.
   *
   * `__rfSourceMap` is written per composite and **never deleted** — `(w.__rfSourceMap ??= {})[id] = …`
   * with no removal anywhere. A source that leaves the draw set therefore leaves its last row behind
   * forever, and a probe reading the whole map every 250ms keeps counting that corpse as a live sample.
   *
   * This produced a wrong finding, stated confidently: "one source sits on `element` with no provider
   * for 97-100% of the arm". The run parks at 7s and the cut is at 11s, so the FIRST clip is past its
   * out-point for most of the sampled window — it was not starved of a decoder, it was not in the scene.
   *
   * The discriminator needs no app change. A row still being graded is rewritten every composite, and
   * `staleMs` is recomputed against an advancing playhead, so *something* in it moves even when the
   * source is stuck. A row that is byte-identical to the previous sample is not being written at all.
   */
  const previous = new Map<string, string>();
  for (const sample of result.samples) {
    for (const src of sample.sources ?? []) {
      const fingerprint = JSON.stringify(src);
      const wasFrozen = previous.get(src.id) === fingerprint;
      previous.set(src.id, fingerprint);
      if (wasFrozen) {
        const row = bySource.get(src.id);
        if (row) row.frozen += 1;
        continue;
      }
      let row = bySource.get(src.id);
      if (!row) {
        row = { asset: src.asset, decode: new Set(), state: new Map(), why: new Map(), provider: 0, providerUnreported: 0, busy: 0, n: 0, frozen: 0 };
        bySource.set(src.id, row);
      }
      row.decode.add(src.decode);
      row.state.set(src.state, (row.state.get(src.state) ?? 0) + 1);
      if (src.why) row.why.set(src.why, (row.why.get(src.why) ?? 0) + 1);
      if (src.wcProvider === null) row.providerUnreported += 1;
      else if (src.wcProvider) row.provider += 1;
      if (src.wcBusy) row.busy += 1;
      row.n += 1;
    }
  }
  for (const [id, row] of bySource) {
    const pct = (n: number) => `${Math.round((n / Math.max(1, row.n)) * 100)}%`;
    const states = [...row.state.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${pct(n)}`).join(" · ");
    const whys = [...row.why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w, n]) => `${w} ${pct(n)}`).join(" · ");
    console.log(
      // The id TAIL, not its head: every source in a project shares the `project_local_<ts>_` prefix, so
      // truncating from the left printed the same 28 characters for both doors and made the two rows
      // indistinguishable — in a table whose entire purpose is telling them apart.
      `   source   ${row.asset.slice(-28)} […${id.slice(-24)}]  decode ${[...row.decode].join("/")}  ${states}` +
        (whys ? `  why: ${whys}` : "") +
        `  wcProvider ${row.providerUnreported === row.n ? "NOT REPORTED BY THIS BUILD" : pct(row.provider)}` +
        `  wcBusy ${pct(row.busy)}` +
        // Percentages are OF LIVE SAMPLES. `graded n/total` is what makes that readable: a source graded
        // in 12 of 40 samples was out of the scene for the rest, and reading its 12 samples as if they
        // covered the arm is the exact error this line exists to prevent anyone repeating.
        `  graded ${row.n}/${row.n + row.frozen}`
    );
  }
  const pool = result.pool;
  if (pool) {
    console.log(
      `   decoder  created ${pool.created} · active ${pool.active} (preload ${pool.activePreload}) · idle ${pool.idle} · ` +
        `retained ${pool.retainedIdle} · retention hits ${pool.retentionHits}/${pool.retentions} · capMisses ${pool.capMisses}`
    );
    // The S4.7 triple, always together. `shareDetaches` is the DONE-WHEN (zero across a soak);
    // `borrowRefusals` is what the predicate cost to get there; `capMisses` is whether that cost was
    // paid in lost sessions. Any one of the three alone is misleading.
    console.log(
      `   sharing  shared ${pool.shared} (active ${pool.sharedActive}) · detaches ${pool.shareDetaches} ` +
        `· refusals ${pool.borrowRefusals ?? 0} · frames served ${pool.sharedFramesServed} (hits ${pool.sharedFrameHits})`
    );
    // THE DIAGNOSIS LINE. A detach names a grant that should not have been made; the grounds say which
    // correction applies. Printed whenever a detach occurred, and also when grants exist at all, so a
    // passing run still shows what it approved rather than only explaining failures.
    const borrow = result.borrow;
    if (borrow) {
      // `grounds` on a grant is S3.3's STRUCTURAL record (key/software compatibility), not the
      // satisfaction verdict — so it cannot name the approval path. `incumbentTimes` can: an empty
      // array IS `known.length === 0`, i.e. the no-incumbent-demand branch.
      const blind = (borrow.grants ?? []).filter((g) => (g.incumbentTimes?.length ?? 0) === 0).length;
      const compared = (borrow.grants ?? []).length - blind;
      console.log(
        `   grants   ${borrow.grants?.length ?? 0} (no-incumbent-demand ${blind} · compared ${compared})` +
          (borrow.refusals?.length
            ? `   refused: ${[...new Set(borrow.refusals.map((r) => r.reason ?? "?"))].join(" · ")}`
            : "") +
          // Printed unconditionally, including the zero. A silent absence would read the same whether the
          // fix never fired or the fixture never reached the path, and those mean opposite things.
          `   blindSplits: ${borrow.blindSplits ?? 0}`
      );
      // THE ANSWER. One line per detach, naming the approval that permitted it.
      for (const d of borrow.detached ?? []) {
        console.log(
          `   ⚠ DETACH approved-as=${d.reason} gapAtApproval=${d.gapSecondsAtApproval ?? "—"} ` +
            `joinerTimeAtApproval=${d.joinerTimeAtApproval ?? "—"} servedAtApproval=${d.servedAtApproval ?? "NEVER-SERVED"} ` +
            `timesAtDetach=${JSON.stringify(d.requestedTimesAtDetach ?? [])}`
        );
      }
    }
  }
  const kernel = result.kernel as { media?: Record<string, unknown>; decoder?: Record<string, unknown> } | null;
  if (kernel?.media) {
    const media = kernel.media as Record<string, any>;
    console.log(
      `   media    declared ${media.declared} · active ${media.active} · ` +
        `demoted ${media.demoted?.length ?? 0} · suppressed ${media.suppressed?.length ?? 0}`
    );
  }
  if (kernel?.decoder) {
    const dec = kernel.decoder as Record<string, any>;
    console.log(
      `   sessions open ${dec.openCount ?? "?"} · held ${dec.held?.length ?? 0} · orphaned ${dec.orphaned?.length ?? 0} · unmet ${dec.unmet?.length ?? 0}`
    );
  }
  const deg = result.degradation as { substitutedTotal?: number; byReason?: { reason: string; count: number }[] } | null;
  if (deg && (deg.substitutedTotal ?? 0) >= 0 && deg.byReason?.length) {
    console.log(
      `   degrade  substituted ${deg.substitutedTotal} · ${deg.byReason.slice(0, 3).map((r) => `${r.reason} ${r.count}`).join(" · ")}`
    );
  }
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const profile = process.env.PROBE_PROFILE;
  let context: BrowserContext;
  // The launched browser is held so teardown can close it. Closing only the context leaves the browser
  // process alive, which keeps node's event loop from draining: the probe then prints its full report
  // and hangs forever. That failure mode is worse than a crash, because the measurement LOOKS complete
  // while the process wedges — it stalled a sequential soak batch for hours and led to a finished run
  // being discarded as "void". A persistent context owns its own browser, so it has nothing to hold.
  let browser: Browser | null = null;
  if (profile) {
    context = await chromium.launchPersistentContext(profile, {
      ...(channel ? { channel } : {}),
      viewport: { width: 1600, height: 900 },
    });
  } else {
    browser = await chromium.launch(channel ? { channel } : {});
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  const explicit = process.env.PROBE_PROJECT;
  let projectUrl: string;
  if (explicit) {
    await page.goto(explicit, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6_000);
    projectUrl = page.url();
  } else {
    // The seed clip must outlast the sample window, or the run measures an empty timeline. See
    // defaultClipPath — this is not hypothetical, it is what the first two runs of this probe did.
    projectUrl = await reachEditor(page, { clipPath: seedClips(1)[0] ?? defaultClipPath(SECONDS + 8) });
  }
  if (!projectUrl.includes("/editor/")) {
    throw new Error(`not in the editor: ${projectUrl}`);
  }
  console.log(`project: ${projectUrl}`);

  /**
   * WEBCODECS PRECONDITION (2026-08-03) — established BEFORE anything plays.
   *
   * `preferNativeDecode` routes a source to the `<video>` element until its ingest proxy lands, and
   * proxy builds suspend during playback. So a soak that starts playing on arrival guarantees the
   * element path and then reports `shared 0 · refusals 0` — a measurement of a subsystem that was never
   * allowed to start, which is precisely how two S4.7 runs were lost and mis-attributed to a
   * non-existent decoder init hang.
   *
   * Waiting here rather than voiding at the end is the difference between a run that CAN answer the
   * S4.7 question and a run that reports the failure articulately after wasting its samples.
   */
  if ((process.env.PROBE_ARMS ?? "demotion") === "satisfaction" || process.env.PROBE_REQUIRE_WC === "1") {
    const engaged = await awaitWebCodecsEngaged(page, Number(process.env.PROBE_WC_WAIT_MS ?? 60_000));
    console.log(
      engaged
        ? "webcodecs: engaged (ingest proxy landed) — the S4.7 subsystem exists in this run"
        : "webcodecs: NEVER ENGAGED — every source is on the element path; sharing numbers below are VOID"
    );
  }

  // The fixture, built once, before either arm. `kernelProxySource` only does anything to a comp that is
  // being served from a proxy; without one the arms are identical by construction and the run is theatre.
  // `PROBE_NO_FIXTURE=1` skips it to measure the flag's UNCONDITIONAL cost, which is a different question
  // and should be asked deliberately rather than by accident.
  // Lead comfortably longer than WARMUP_MS: the pre-roll shell mounts ~1.2s before the cut, and a lead
  // of 2s would put the whole crossing inside the discarded warmup — the counters would still see it
  // (they are cumulative and read at the tail) but the frame-budget samples would not, so a cost paid
  // exactly at the crossing would be invisible. 4s puts the mount ~1.3s into the sampled window.
  let seekLeadSeconds: number | null = null;
  let hasFixture = false;
  let boundSources = 0;
  if (process.env.PROBE_NO_FIXTURE !== "1") {
    console.log("building fixture: Flarex comp + asset-source MediaIn + proxy");
    // The MediaIn goes in BEFORE the proxy is rendered, so the proxy is built over the comp this run
    // actually measures. Building it first and editing after would invalidate it on the next frame —
    // comp.version is the proxy's key.
    // Extra DISTINCT assets first: `addMediaInBoundTo` addresses tiles by index, so they must exist
    // before any node asks for one. Skipped entirely at SOURCES=1, which keeps the default path
    // byte-identical to every arm comparison already recorded against this probe.
    if (SOURCES > 1) {
      const extra = seedClips(SOURCES).slice(1);
      const tiles = await importAssets(page, extra);
      console.log(`  · asset bin: ${tiles} tile(s) after importing ${extra.length} distinct file(s)`);
    }

    const mediaIn = await addAssetSourceMediaIn(page);
    console.log(
      `  · asset-source MediaIn 1: ${
        mediaIn.ok
          ? `bound → ${mediaIn.detail ?? "?"}`
          : `FAILED at gate \`${mediaIn.gate}\`${mediaIn.detail ? ` (${mediaIn.detail})` : ""} — comp declares no source`
      }`
    );
    boundSources = mediaIn.ok ? 1 : 0;
    for (let i = 1; i < SOURCES; i += 1) {
      // Tile index i: tile 0 is the host clip, already taken by `addAssetSourceMediaIn` above.
      const extraIn = await addMediaInBoundTo(page, i);
      if (extraIn.ok) boundSources += 1;
      console.log(
        `  · asset-source MediaIn ${i + 1}: ${
          extraIn.ok ? `bound → ${extraIn.detail ?? "?"}` : `FAILED at gate \`${extraIn.gate}\``
        }`
      );
    }
    if (SOURCES > 1) console.log(`  · sources bound: ${boundSources}/${SOURCES}`);
    // The preload crossing. Only needed for the S4.7 arms, where a borrow across two DIFFERENT times is
    // the thing under test; the demotion arms do not need it and it would only add decode load.
    if ((process.env.PROBE_ARMS ?? "demotion") === "satisfaction") {
      // PROBE_CUTS>1 exists because a detach is a RACE, not a certainty: one crossing per run makes each
      // ~10-minute run a single lottery ticket, and a seven-run series bought exactly one detach event —
      // not enough to name a mechanism. Each additional cut is another crossing of the SAME borrow path
      // the fixture already exercises, so this raises the sample count without inventing an attach
      // ordering that could not occur in production. `cutClipAtFraction` always splits the FIRST clip, so
      // repeated calls walk the boundaries backwards toward the start; parking before the earliest one
      // and playing forward crosses all of them in one pass, with no mid-arm seeking to perturb the
      // frame budget. Default 1 keeps every existing arm comparison byte-identical.
      const cuts = Math.max(1, Number(process.env.PROBE_CUTS ?? 1));
      const made: number[] = [];
      for (let i = 0; i < cuts; i += 1) {
        const cut = await cutClipAtFraction(page, Number(process.env.PROBE_CUT_FRACTION ?? 0.55));
        if (cut == null) break;
        made.push(cut);
      }
      console.log(
        made.length > 0
          ? `  · ${made.length} cut(s) at ${made.map((c) => `${c.toFixed(2)}s`).join(", ")} — preload crossing(s) reachable`
          : "  · cut FAILED"
      );
      // Reachable is not visited. Only park before the cut if there IS one; parking off a single clip
      // would land the playhead somewhere arbitrary and quietly change what the arms measure.
      if (made.length > 0) seekLeadSeconds = Number(process.env.PROBE_SEEK_LEAD ?? 4);
    }
    hasFixture = await buildFlarexProxyFixture(page);
    console.log(hasFixture ? "  · proxy ready" : "  · FIXTURE FAILED — arms will not exercise demotion");
  }
  console.log(`arms: ${ARMS.length} × ${SECONDS}s of playback (after ${WARMUP_MS}ms warmup), same page, same project`);

  const results: ArmResult[] = [];
  for (const arm of ARMS) {
    // Progress on stdout as it happens. A probe that drives a browser for minutes and prints only at
    // the end is indistinguishable from a hung one, which cost a debugging round the first time.
    console.log(`  · ${arm.name}: reloading with ?${arm.flags}`);
    await reopenWithFlags(page, projectUrl, arm.flags);
    console.log(`  · ${arm.name}: playing ${SECONDS}s`);
    results.push(await sampleArm(page, `${arm.name}   [?${arm.flags}]`, seekLeadSeconds));
    console.log(`  · ${arm.name}: done`);
  }

  console.log("\n════ frame budget ════");
  for (const result of results) report(result);

  // VACUITY GUARD. A compositor happily repaints an unchanged frame at display refresh, so an arm whose
  // playhead sat past the end of its own material reports a flawless ~75fps while decoding nothing — and
  // two such arms agree with each other to three significant figures, which reads as a beautifully
  // reproducible null result rather than as a broken measurement. It is the frame-budget equivalent of a
  // vacuous assertion, and the ratchet's rule applies: an instrument that cannot fail is not evidence.
  const decodedInArm = (r: ArmResult): boolean => {
    if (r.samples.some((s) => s.mediaFps > 0)) return true; // element path
    const seen = new Set<number>();
    for (const sample of r.samples) for (const t of sample.served) seen.add(Math.round(t * 1000));
    return seen.size > 1; // WebCodecs path: served times ADVANCED
  };
  const vacuous = results.filter((r) => r.samples.length > 0 && !decodedInArm(r));
  if (vacuous.length > 0) {
    console.log(
      `\n[budget] ⚠ VOID — no video frames were presented in ${vacuous.length}/${results.length} arm(s).\n` +
        "         The compositor ran, the decoder did not: the playhead was past the end of its material,\n" +
        "         or every layer was a still. These numbers compare an empty timeline with an empty\n" +
        "         timeline. Seed a longer clip (PROBE_CLIP) or shorten PROBE_SECONDS."
    );
  }

  // COMPARABILITY GUARD, the other half of the vacuity one. Two arms are only comparable if they did the
  // same amount of work per frame, and `renderScale` is the one input that silently differs — Auto is a
  // closed loop and even pinned, a click can miss. Reporting a delta across different resolutions is
  // reporting the resolution.
  const scales = new Set(
    results.flatMap((r) => r.samples.map((s) => s.renderScale))
  );
  if (scales.size > 1) {
    console.log(
      `\n[budget] ⚠ VOID — render scale was not constant across the run (${[...scales].join(", ")}).\n` +
        "         Auto quality adapts the workload to the workload, so this delta is the resolution,\n" +
        "         not the flag. Pin a fixed resolution before trusting the comparison."
    );
  }

  // The third way this comparison can be void: nothing was demoted, so both arms ran the same code.
  /**
   * ADR-013 Phase 0 / M0 — the vacuity guard, declared with the measurement rather than discovered.
   *
   * The rule this enforces: **a counter that reads 0 because the path was never reached is
   * indistinguishable from one that reads 0 because the path is clean.** It is the same rule as
   * "`detaches 0 · blindSplits 0` must be read as VOID", one subsystem along, and M0's first run was
   * lost to exactly it — two arms, `capMisses 0` on both, on a fixture that opened two sessions against
   * a four-slot budget and could not have been denied by construction.
   *
   * So M0 requires evidence that the CONTENTION path was live: sessions reaching the cap, or a cap miss
   * actually recorded. Without it the arms agree about a path neither of them exercised.
   */
  if ((process.env.PROBE_ARMS ?? "demotion").startsWith("observer")) {
    const contended = results.some((r) => {
      const pool = r.pool as { capMisses?: number; created?: number; active?: number } | null;
      return (pool?.capMisses ?? 0) > 0;
    });
    const peakActive = Math.max(
      0,
      ...results.map((r) => Number((r.pool as { active?: number } | null)?.active ?? 0))
    );
    if (!contended) {
      console.log(
        "\n[budget] ⚠ VOID for the M0 observer question — the contention path was never reached.\n" +
          `         capMisses 0 in every arm; peak active sessions ${peakActive} of a 4-slot budget.\n` +
          `         ${boundSources} asset-source MediaIn(s) bound. An instrument on the contention path\n` +
          "         cannot be shown to perturb it, or not to, by a run that never contended.\n" +
          "         Re-run with PROBE_SOURCES=6 (distinct files) to exceed the budget."
      );
    } else {
      console.log(
        `\n[budget] M0 contention guard: PASSED — capMisses > 0, peak active ${peakActive}, ` +
          `${boundSources} sources bound.`
      );
    }
  }

  const demotedAnywhere = results.some((r) => {
    const media = (r.kernel as { media?: { demoted?: string[] } } | null)?.media;
    return (media?.demoted?.length ?? 0) > 0;
  });
  const armsVaryDemotion = (process.env.PROBE_ARMS ?? "demotion") === "demotion";
  if (!demotedAnywhere && armsVaryDemotion && process.env.PROBE_NO_FIXTURE !== "1") {
    console.log(
      "\n[budget] ⚠ VOID for the demotion question — no source was ever demoted in either arm.\n" +
        `         ${hasFixture ? "The proxy built but never served during the sample window." : "The fixture failed to build."}\n` +
        "         This still measures the flag's unconditional cost, which is a different question."
    );
  }

  // The fourth way this run can be void, and the one S4.7 keeps tripping over: the fixture can REACH the
  // crossing without the run VISITING it. If neither arm ever detached and neither ever refused, then the
  // arm that still contains the defect satisfied the done-when too — which says the fixture never got
  // near the state, not that the state is fixed. The asymmetry IS the evidence, so say so when it is
  // missing rather than printing two tidy zeroes and calling it a pass.
  if ((process.env.PROBE_ARMS ?? "demotion") === "satisfaction") {
    // FIFTH way, and it precedes all the others: the WebCodecs path can be off entirely. S4.7 governs
    // WebCodecs SESSION sharing — `findAttachableSession`, `SharedMember`, `noteDivergence`. On the
    // `<video>` element path there are no sessions to share, so `shared 0 · refusals 0` is not a strict
    // predicate, it is an absent subsystem. The 2026-08-03 run that prompted this check read
    // `decode element` on all four sources in both arms and still produced numbers tidy enough to
    // argue about for an hour.
    //
    // Checked BEFORE the detach/refusal guard because it explains that guard's own failure: a path
    // that is off cannot detach or refuse either, so the symptom test cannot distinguish "fixed" from
    // "never ran". Two recorded freeze post-mortems already say to read the decode mode first.
    const allSources = results.flatMap((r) => r.samples.flatMap((s) => s.sources ?? []));
    const wcSeen = allSources.some((src) => src.wcProvider === true);
    const wcUnreported = allSources.length > 0 && allSources.every((src) => src.wcProvider === null);
    if (!wcSeen) {
      const why = wcUnreported
        ? "No source reported wcProvider at all (this build does not publish it)."
        : "Every source decoded through the <video> element path.";
      console.log(
        "\n[budget] ⚠ VOID for the S4.7 done-when — the WebCodecs path was never engaged.\n" +
          `         ${why}\n` +
          "         S4.7 guards WebCodecs session sharing, so there was nothing for it to guard.\n" +
          "         Re-run with PROBE_EXTRA_FLAGS=wcDecode=1 before reading any sharing number\n" +
          "         below as evidence about the predicate."
      );
    }
    const engaged = results.some(
      (r) => (Number(r.pool?.shareDetaches ?? 0) > 0) || (Number(r.pool?.borrowRefusals ?? 0) > 0)
    );
    if (!engaged && wcSeen) {
      console.log(
        "\n[budget] ⚠ VOID for the S4.7 done-when — no arm ever detached OR refused a borrow.\n" +
          "         The flag-OFF arm is supposed to reproduce the harm; it did not, so zero divergence\n" +
          "         in the flag-ON arm is an absence of evidence, not evidence. The crossing was\n" +
          "         reachable but not visited. Frame-budget numbers below are still valid."
      );
    }
  }

  const [a, b] = results;
  if (a && b && a.samples.length > 0 && b.samples.length > 0) {
    const fpsA = percentile(a.samples.map((s) => s.fps), 50);
    const fpsB = percentile(b.samples.map((s) => s.fps), 50);
    const delta = fpsB - fpsA;
    console.log(
      `\n[budget] p50 fps  baseline ${fpsA.toFixed(1)} → demotion ${fpsB.toFixed(1)}  ` +
        `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)}, ${((delta / fpsA) * 100).toFixed(1)}%)`
    );
    // No assertion: on a comp-free project there is nothing to demote and parity is the expected result,
    // so a threshold here would only ever fire on noise. The number is the deliverable.
  }
  if (errors.length) console.log(`\nconsole errors (${errors.length}):\n${errors.slice(0, 5).map((e) => `  ${e}`).join("\n")}`);

  // Teardown is bounded and never allowed to fail the run: every number above is already printed, so a
  // browser that will not close is a harness problem, not a measurement problem. Racing a timer keeps a
  // stuck close from re-creating the hang this guard exists to remove.
  const closed = (async () => {
    await context.close();
    await browser?.close();
  })();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 15_000))]).catch(() => {
    /* teardown is best-effort — the report is the deliverable */
  });
}

main()
  .then(() => {
    // Backstop for a handle nobody thought to close. `unref()` is the whole point: if the loop is already
    // drained the process exits immediately and this timer never fires, so the normal path keeps its
    // natural exit and flushes stdout the ordinary way. It only fires when something IS still holding the
    // loop open — the case that used to hang forever — and 5s is long enough for the report to be flushed.
    setTimeout(() => process.exit(0), 5_000).unref();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
