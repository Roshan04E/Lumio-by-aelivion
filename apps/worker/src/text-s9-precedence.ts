/**
 * S9 PRECEDENCE GATE (ADR-023 T-14, OQ6) — written BEFORE the feature, deliberately.
 *
 *   pnpm --filter @orreris/worker text:s9-precedence
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS FIRST. S8 shipped a rule — "warp wins over a curve" —
 * that was declared in a doc comment, true of the outer draw, and FALSE underneath: warp rasterizes
 * by recursively calling the ordinary draw, so the curve was applied and then deformed, composing
 * two geometries in an order nobody chose. Nothing caught it until a control was written as an
 * EQUALITY against warp-alone. A difference assertion would have passed on the composed picture.
 *
 * S9 composes per-cluster transforms with warp, with the arc curve, and with the text matte. Every
 * one of those is a declared precedence that nothing enforces until someone writes the equality. So
 * they are written here first, and they are expected to FAIL on a tree where the feature does not
 * exist — a gate that passes before the feature exists cannot tell whether it arrived.
 *
 * ## ⚠ THIS GATE IS RED ON PURPOSE. DO NOT RE-TIER IT AS BROKEN.
 *
 * It fails at the SUBJECT, with a message that says so, and it stays red until the per-character
 * animator lands. That is the `pending()` pattern this repo already uses — a harness check that
 * asserts the DEFECT (here: the absence) still reproduces. Three things follow, and each has been got
 * wrong before:
 *
 *   - **Do not "fix" it** by relaxing the subject, by skipping it, or by moving it to a quarantine
 *     list. The failure IS the current, correct reading.
 *   - **Do not make it green** except by shipping the feature. An equality that holds because nothing
 *     animates is not evidence of a precedence, which is why every equality below is paired with a
 *     subject.
 *   - **Do not batch it into a sweep** that reports a pass/fail count as a health signal; it will be
 *     the one red line and will read as a regression to anyone who did not open this file.
 *
 * S9a (the static variable axis) shipped separately and does NOT change any of this: it adds no
 * animation, touches no branch these arms exercise, and the hashes below are unaffected by it.
 *
 * THE FOUR DECLARED PRECEDENCES:
 *
 *   P1  Per-cluster animation composes UNDER warp. Warp deforms the ALREADY-ANIMATED picture, which
 *       is the useful composition (letters popping in on a wavy banner) and is free: warp's inner
 *       draw is an ordinary draw. Stated as an equality at animation IDENTITY — warp plus a settled
 *       animation must be byte-identical to warp alone — because that is the form that catches the
 *       S8 defect shape, where a path perturbs the raster even when it should be contributing
 *       nothing.
 *
 *   P2  The arc curve WINS over per-cluster animation. A curved run is drawn by the SVG surface,
 *       which hands back one finished picture and no cluster bands; slicing it would need per-glyph
 *       positions along the arc that nothing exposes. So a curved run ignores the animation, and
 *       says so rather than animating something subtly wrong.
 *
 *   P3  A shaping-dependent script WINS over per-cluster animation (T-14, and the reason
 *       `detectTextScript` survived S7 half B's deletion). Not a policy choice: OQ6's spike measured
 *       that on Arabic 2 of 13 prefix widths go BACKWARDS, because `measureText` shapes each prefix
 *       in isolation — so the cluster bands are wrong before a pixel is drawn.
 *
 *   P4  At rest, the animation contributes NOTHING. A settled per-cluster animation must render
 *       byte-identically to a layer with no animation at all. This is the D1a claim and OQ6's
 *       shaping claim in one assertion: the slices tile the shaped raster back together exactly.
 *
 * Each equality is paired with a SUBJECT that proves it is not vacuous — an equality that holds
 * because nothing is happening anywhere is not evidence of a precedence.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderManifest } from "@orreris/render-templates";
import {
  createRenderComparisonFixture,
  renderComparisonFrameSeconds,
  type RenderComparisonFixtureKey,
  type TimelineLayer
} from "@orreris/shared";
import { assertQuietBrowserMachine, listAutomationBrowsers } from "./browser/browser-preflight";
import { renderManifestStill } from "./remotion-renderer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "text-s9-precedence");

type Override = Partial<Record<string, unknown>>;

/** Render a fixture with `override` applied to every text layer, and hash the PNG. */
async function renderWith(key: RenderComparisonFixtureKey, label: string, override: Override): Promise<string> {
  const fixture = createRenderComparisonFixture(key);
  const composition = fixture.graph.composition;
  if (!composition) throw new Error(`Fixture "${key}" must include a composition.`);

  let touched = 0;
  const applyTo = (layer: TimelineLayer): TimelineLayer => {
    touched += 1;
    const next = { ...layer } as Record<string, unknown>;
    for (const [field, value] of Object.entries(override)) {
      if (value === undefined) delete next[field];
      else next[field] = value;
    }
    return next as unknown as TimelineLayer;
  };

  const graph = {
    ...fixture.graph,
    composition: {
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((layer) => (layer.type === "text" ? applyTo(layer) : layer))
      }))
    }
  };
  assert.ok(touched > 0, `Fixture "${key}" has no text layer to override — the arm is void.`);

  const manifest = buildRenderManifest({
    projectId: graph.projectId,
    graph,
    assets: fixture.assets,
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const frame = Math.round(renderComparisonFrameSeconds * manifest.output.fps);
  const outputLocation = path.join(outDir, `${label}.png`);
  await renderManifestStill({ manifest, frame, outputLocation, rendererMode: "webgl" });
  return createHash("sha256").update(fs.readFileSync(outputLocation)).digest("hex");
}

const short = (hash: string) => hash.slice(0, 12);

/** A settled animation: every cluster has arrived. */
const AT_REST = { clusterRevealProgress: 1, clusterRiseEm: 0.8, clusterStaggerFraction: 0.6 };
/** Mid-flight: clusters are displaced and partly faded, which is the only state that proves anything. */
const MID = { clusterRevealProgress: 0.45, clusterRiseEm: 0.8, clusterStaggerFraction: 0.6 };
/** No animation at all — the keys absent, not set falsy (the legacy shape). */
const NONE = { clusterRevealProgress: undefined, clusterRiseEm: undefined, clusterStaggerFraction: undefined };
const WARP = { textWarp: { style: "arc", bend: 40, distortH: 0, distortV: 0 } };

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "text:s9-precedence", scriptMarker: "text-s9-precedence" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);
  fs.mkdirSync(outDir, { recursive: true });

  // --- the SUBJECT, first: does the feature exist at all? --------------------------------------
  const none = await renderWith("scaled-text", "none", NONE);
  const mid = await renderWith("scaled-text", "mid", MID);
  const atRest = await renderWith("scaled-text", "at-rest", AT_REST);
  process.stdout.write(`latin      none=${short(none)}  mid-flight=${short(mid)}  at-rest=${short(atRest)}\n`);

  // --- P1: composes under warp -------------------------------------------------------------------
  const warpOnly = await renderWith("scaled-text", "warp-only", { ...NONE, ...WARP });
  const warpAtRest = await renderWith("scaled-text", "warp-at-rest", { ...AT_REST, ...WARP });
  const warpMid = await renderWith("scaled-text", "warp-mid", { ...MID, ...WARP });
  process.stdout.write(`warp       alone=${short(warpOnly)}  +at-rest=${short(warpAtRest)}  +mid=${short(warpMid)}\n`);

  // --- P2: the curve wins ------------------------------------------------------------------------
  const curveOnly = await renderWith("path-text", "curve-only", NONE);
  const curveMid = await renderWith("path-text", "curve-mid", MID);
  process.stdout.write(`curve      alone=${short(curveOnly)}  +mid=${short(curveMid)}\n`);

  // --- P3: a shaping-dependent script wins -------------------------------------------------------
  const arabic = { textRuns: undefined, text: "مرحبا بالعالم" };
  const arabicOnly = await renderWith("scaled-text", "arabic-only", { ...NONE, ...arabic });
  const arabicMid = await renderWith("scaled-text", "arabic-mid", { ...MID, ...arabic });
  process.stdout.write(`arabic     alone=${short(arabicOnly)}  +mid=${short(arabicMid)}\n\n`);

  // --- assertions --------------------------------------------------------------------------------
  assert.notEqual(
    mid,
    none,
    "SUBJECT FAILED — a mid-flight per-cluster animation renders identically to no animation. Either the " +
      "feature does not exist yet (which is the expected state before S9 ships, and is exactly why this " +
      "gate is written first) or its fields are not reaching the renderer. Every equality below is " +
      "VACUOUS until this line passes: they would all hold trivially on a tree where nothing animates."
  );

  assert.equal(
    atRest,
    none,
    "P4 FAILED — a SETTLED per-cluster animation is not byte-identical to no animation. Two things this " +
      "could be, and both matter: the slices are not tiling the shaped raster back together exactly (OQ6's " +
      "equality, so shaping is being disturbed), or the animation path perturbs the raster even when every " +
      "cluster has arrived (so absence and rest have stopped meaning the same thing — the D1a claim)."
  );

  assert.notEqual(
    warpMid,
    warpOnly,
    "P1 FAILED — warp plus a mid-flight animation renders identically to warp alone, so the animation is " +
      "NOT composing under warp. Warp's inner draw is an ordinary draw; if the animation is being stripped " +
      "there (as the CURVE deliberately is), this precedence has silently become 'warp wins'."
  );
  assert.equal(
    warpAtRest,
    warpOnly,
    "P1 FAILED (the S8 shape) — warp plus a SETTLED animation differs from warp alone. The animation is " +
      "contributing something at rest, underneath a warp, where it must contribute nothing. This is the " +
      "assertion that would have caught 'warp wins over a curve' being declared and not enforced."
  );

  assert.equal(
    curveMid,
    curveOnly,
    "P2 FAILED — a curved run responded to a per-cluster animation. The curve WINS: it is drawn by the SVG " +
      "surface, which returns one finished picture and no cluster bands, so there is nothing to slice. A " +
      "difference here means something is slicing a picture whose glyph positions it does not know."
  );

  assert.equal(
    arabicMid,
    arabicOnly,
    "P3 FAILED (T-14) — an Arabic layer responded to a per-cluster animation. It must not: OQ6's spike " +
      "measured that 2 of 13 prefix widths go BACKWARDS on this script, because `measureText` shapes each " +
      "prefix in isolation, so the cluster bands are wrong before anything is drawn. Animating over that " +
      "reintroduces, in a new feature, exactly the defect D9a's warp rework was written to remove."
  );

  process.stdout.write("PASS — the animation exists, contributes nothing at rest, composes under warp, and is refused by the curve and by a shaping-dependent script.\n");
  process.stdout.write(`stills: ${outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
