/**
 * LINEAR-LIGHT GATE — "is the effect stage mixing light, or code values?"
 *
 * The two gates either side of this one cannot answer that question.
 *
 *   · `render:compare:pixels` is DIFFERENTIAL: it proves the web preview and Remotion agree. A wrong
 *     transfer function that BOTH apply reads 0.000% and passes. That is DEBT-017's first axis, and it
 *     is how a glow whose kernel truncated at 96px agreed perfectly across both renderers for two
 *     months.
 *   · `render:baseline` is a STILL gate: it proves the picture did not change. It is exactly the wrong
 *     instrument for a change whose entire purpose is to change the picture.
 *
 * This one renders a known input and checks the answer against arithmetic — the same shape of
 * instrument that found the glow ratio and radial blur's dead Centre Y.
 *
 * ## The assertions
 *
 * TWO probes, one per stage the programme has converted, because they can fail independently: the
 * plate path (slice 1) and the transition mix (slice 4) share a setting but not a line of code.
 *
 * ### 1. A blurred hard edge (slice 1)
 *
 * A hard black/white edge, blurred. The midpoint of the resulting ramp has exactly one right answer
 * per space:
 *
 *     blurred on GAMMA-ENCODED values → the midpoint is the average of the codes → code 128
 *     blurred in LINEAR light         → the midpoint is linear 0.5, which ENCODES to code 188
 *
 * Both arms are asserted, and that is the point rather than thoroughness: if `effectLight` silently
 * failed to reach a renderer — the exact failure the manifest threading exists to prevent, and one no
 * parity diff can see — the linear arm would read ~128 and this fails loudly.
 *
 * ### 2. A crossfade at its exact midpoint (slice 4)
 *
 * Black clip dissolving to white clip, sampled at progress 0.5 — the canonical light-mixing operation
 * and the one the founder-facing claim is about ("dissolves stop dipping dark through the middle").
 * The arithmetic is the same because the operation is the same, a weighted sum of two colours:
 *
 *     mixed on GAMMA-ENCODED values → (0 + 255)/2            → code 128   ← the dark dip
 *     mixed in LINEAR light         → (0.0 + 1.0)/2 = 0.5    → code 188
 *
 * Deliberately NOT reusing the blur probe's comp. The two stages could regress independently — the
 * transition mix has its own shaders, its own program cache and its own light-space key — and a gate
 * that measures one while claiming both is the reassuring-null-result failure this file exists to
 * avoid. `crossDissolve` eases `easeInOut`, which is symmetric, so the window's midpoint really is
 * progress 0.5 and the prediction is exact rather than approximate.
 *
 * ## Why NOT the white-vs-grey contribution ratio the plan originally specified (§4.3)
 *
 * Because it cannot discriminate. On a black field the display arm's ratio-of-codes is 1/0.6 = 1.67,
 * and the linear arm's ratio-of-LIGHT is 3.14, which encodes to 3.14^(1/2.4) ≈ 1.70. Measured: 1.68
 * and 1.71. The plan's "1.68 → 3.24" is the same pixels described in two spaces, not two outcomes.
 * An instrument that returns the same number whichever way the code behaves is not evidence, and this
 * file exists partly so nobody re-derives that chart and reads it as a pass.
 *
 *     pnpm --filter @orreris/worker render:linear-gate
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderManifest } from "@orreris/render-templates";
import { createFlarexComp, createFlarexNode, createRenderComparisonFixture } from "@orreris/shared";
import { PNG } from "pngjs";
import { renderManifestStill } from "./remotion-renderer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "render-linear-gate");

/** Blur sigma for the test edge. Large enough that the ramp is many pixels wide, so the midpoint is
 *  not sitting on a single quantised step. */
const SIGMA = 40;

const EXPECTED_DISPLAY = 128;
const EXPECTED_LINEAR = 188;

/**
 * ±6 code values.
 *
 * Chosen from measurement, not taste. The arms read 126.0 and 186.0 against predictions of 128 and
 * 188 — a 2-code deviation, from the discrete Gaussian's finite tap set and the transform's edge
 * landing on a pixel boundary. 6 gives 3× headroom over that while staying an order of magnitude
 * inside the thing being detected: the two spaces are 60 code values apart, so a stage that ran in the
 * wrong light misses by 10× the tolerance. There is no value of this bar between 3 and 50 that would
 * change a verdict, which is the property a good bar has.
 */
const TOLERANCE = 6;

/** Left half white, right half black, blurred by SIGMA. The seam sits at the comp centre. */
function buildComp() {
  const comp = createFlarexComp("lg_comp", "Linear gate");
  const black = createFlarexNode("background", "lg_black");
  black.params = { ...black.params, color: "#000000", opacity: 1 };
  const white = createFlarexNode("background", "lg_white");
  white.params = { ...white.params, color: "#ffffff", opacity: 1 };
  // Scale 1 is the full frame; shifting it left by 50% puts its right edge at the comp centre.
  const tf = createFlarexNode("transform", "lg_tf");
  tf.params = { ...tf.params, x: -50 };
  const merge = createFlarexNode("merge", "lg_merge");
  const blur = createFlarexNode("blur", "lg_blur");
  blur.params = { ...blur.params, sigma: SIGMA };
  for (const n of [black, white, tf, merge, blur]) comp.nodes[n.id] = n;
  comp.edges = [
    { id: "lg_e1", from: { nodeId: black.id, socket: "out" }, to: { nodeId: merge.id, socket: "bg" } },
    { id: "lg_e2", from: { nodeId: white.id, socket: "out" }, to: { nodeId: tf.id, socket: "in" } },
    { id: "lg_e3", from: { nodeId: tf.id, socket: "out" }, to: { nodeId: merge.id, socket: "fg" } },
    { id: "lg_e4", from: { nodeId: merge.id, socket: "out" }, to: { nodeId: blur.id, socket: "in" } },
    { id: "lg_e5", from: { nodeId: blur.id, socket: "out" }, to: { nodeId: "lg_comp_out", socket: "in" } }
  ];
  return comp;
}

function graphWith(light: "display" | "linear") {
  const fixture = createRenderComparisonFixture("flarex-generators");
  const graph = JSON.parse(JSON.stringify(fixture.graph)) as Record<string, unknown> & {
    projectId: string;
    flarexComps: Record<string, unknown>;
    composition: { settings: { color: { effectLight: string } } };
  };
  const oldId = Object.keys(graph.flarexComps ?? {})[0]!;
  graph.flarexComps = { [oldId]: JSON.parse(JSON.stringify(buildComp()).replace(/lg_comp/g, oldId)) };
  // The fixture stamps its own effect light; this overrides it to build the two arms.
  graph.composition.settings.color.effectLight = light;
  return { graph, assets: fixture.assets };
}

async function midpointFor(light: "display" | "linear"): Promise<number> {
  const { graph, assets } = graphWith(light);
  const manifest = buildRenderManifest({
    projectId: graph.projectId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the probe graph is a fixture clone
    graph: graph as any,
    assets,
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const file = path.join(outDir, `${light}.png`);
  await renderManifestStill({ manifest, frame: 12, outputLocation: file, rendererMode: "webgl" });
  const png = PNG.sync.read(fs.readFileSync(file));
  const y = Math.floor(png.height / 2);
  const at = (x: number): number => {
    const o = (y * png.width + x) * 4;
    return 0.2126 * png.data[o]! + 0.7152 * png.data[o + 1]! + 0.0722 * png.data[o + 2]!;
  };
  const cx = Math.floor(png.width / 2);
  const mid = at(cx);
  console.log(
    `  ${light.padEnd(7)} midpoint=${mid.toFixed(1).padStart(6)}   ramp: -60px=${at(cx - 60).toFixed(0).padStart(3)}` +
      `  -20=${at(cx - 20).toFixed(0).padStart(3)}  0=${mid.toFixed(0).padStart(3)}` +
      `  +20=${at(cx + 20).toFixed(0).padStart(3)}  +60=${at(cx + 60).toFixed(0).padStart(3)}`
  );
  return mid;
}

/**
 * The crossfade arm's graph: the `transition` fixture's two-clip junction with both sides replaced by
 * FLAT shapes — outgoing black, incoming white — so the mixed value has a closed-form prediction
 * instead of "whatever those two photographs average to".
 *
 * The junction window is Premiere-style CENTRED ON THE CUT — [cut - D/2, cut + D/2], see
 * `getActiveTransition` — so with the fixture's cut at 0.4s the midpoint is the cut itself: frame 12 at
 * 30fps, where progress is exactly 0.5. (Read from the code, not assumed: the first attempt used the
 * fixture's own comment, which still describes the old start-aligned window, and rendered a finished
 * dissolve. The flatness guard reported 255 and the assertion caught it.) Everything
 * outside the video track is emptied: a caption or overlay drawn over the sample point would be
 * measured instead of the mix, and it would look like a plausible number rather than an obvious fault.
 */
const CROSSFADE_FRAME = 12;

function crossfadeGraphWith(light: "display" | "linear") {
  const fixture = createRenderComparisonFixture("transition");
  const graph = JSON.parse(JSON.stringify(fixture.graph)) as {
    projectId: string;
    composition: {
      settings: { color: { effectLight: string } };
      tracks: { type: string; layers: Record<string, unknown>[] }[];
    };
  };
  graph.composition.settings.color.effectLight = light;
  for (const track of graph.composition.tracks) {
    if (track.type !== "video") {
      track.layers = [];
      continue;
    }
    track.layers = track.layers.map((layer, index) => ({
      ...layer,
      type: "shape",
      shapeKind: "rectangle",
      // A shape layer draws an ELEMENT BOX, not the frame: without these it renders a small centred
      // rounded rect and the probe measures the background. The flatness guard caught exactly that.
      widthPercent: 100,
      heightPercent: 100,
      borderRadius: 0,
      color: index === 0 ? "#000000" : "#ffffff",
      assetId: undefined,
      effects: [],
      keyframes: []
    }));
  }
  return { graph, assets: fixture.assets };
}

async function crossfadeMidpointFor(light: "display" | "linear"): Promise<number> {
  const { graph, assets } = crossfadeGraphWith(light);
  const manifest = buildRenderManifest({
    projectId: graph.projectId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the probe graph is a fixture clone
    graph: graph as any,
    assets,
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const file = path.join(outDir, `crossfade-${light}.png`);
  await renderManifestStill({ manifest, frame: CROSSFADE_FRAME, outputLocation: file, rendererMode: "webgl" });
  const png = PNG.sync.read(fs.readFileSync(file));
  const at = (x: number, y: number): number => {
    const o = (y * png.width + x) * 4;
    return 0.2126 * png.data[o]! + 0.7152 * png.data[o + 1]! + 0.0722 * png.data[o + 2]!;
  };
  const cx = Math.floor(png.width / 2);
  const cy = Math.floor(png.height / 2);
  const mid = at(cx, cy);
  // The mix is FLAT, so four spread samples agreeing is the check that we are reading the dissolve and
  // not a corner of something else. A wide spread here means the frame is not what this probe thinks.
  const corners = [at(cx >> 1, cy >> 1), at(cx + (cx >> 1), cy >> 1), at(cx >> 1, cy + (cy >> 1))];
  const spread = Math.max(...corners, mid) - Math.min(...corners, mid);
  console.log(
    `  ${light.padEnd(7)} midpoint=${mid.toFixed(1).padStart(6)}   flatness spread=${spread.toFixed(1)}` +
      `  samples: ${[mid, ...corners].map((v) => v.toFixed(0)).join(" ")}`
  );
  assert.ok(
    spread < 2,
    `The crossfade probe's frame is not flat (spread ${spread.toFixed(1)} codes). It is measuring ` +
      `something other than a black→white dissolve, so its midpoint means nothing.`
  );
  return mid;
}

async function main(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Linear-light gate: blurred hard edge, sigma ${SIGMA}, tolerance ±${TOLERANCE} codes\n`);

  const display = await midpointFor("display");
  const linear = await midpointFor("linear");

  console.log("");
  assert.ok(
    Math.abs(display - EXPECTED_DISPLAY) <= TOLERANCE,
    `DISPLAY arm midpoint ${display.toFixed(1)} is not ${EXPECTED_DISPLAY}±${TOLERANCE}. The display-referred ` +
      `stage should average the CODE values. Reading ~${EXPECTED_LINEAR} here would mean the linear stage is ` +
      `running for a project that did not ask for it.`
  );
  console.log(`  OK  display arm mixes CODE values  (${display.toFixed(1)} ≈ ${EXPECTED_DISPLAY})`);

  assert.ok(
    Math.abs(linear - EXPECTED_LINEAR) <= TOLERANCE,
    `LINEAR arm midpoint ${linear.toFixed(1)} is not ${EXPECTED_LINEAR}±${TOLERANCE}. Reading ~${EXPECTED_DISPLAY} ` +
      `means the effect stage is still mixing code values — either the boundary regressed, or ` +
      `composition.settings.color.effectLight is not reaching this renderer, which no parity gate can see.`
  );
  console.log(`  OK  linear arm mixes LIGHT         (${linear.toFixed(1)} ≈ ${EXPECTED_LINEAR})`);

  // The two arms must also differ from each other by much more than the tolerance. Belt and braces
  // against a future where both expectations drift together — e.g. someone "fixes" the constants to
  // match a broken build. The gap is the physics; the absolute values are only where it lands.
  assert.ok(
    linear - display > 40,
    `The two arms differ by only ${(linear - display).toFixed(1)} codes; the spaces are ~60 apart. ` +
      `Both arms agreeing means the setting is not switching anything.`
  );
  console.log(`  OK  the arms are ${(linear - display).toFixed(1)} codes apart (the spaces differ by ~60)\n`);

  // ---- Probe 2: the crossfade midpoint (slice 4) -------------------------------------------------
  console.log(`Crossfade midpoint: black → white crossDissolve at progress 0.5, tolerance ±${TOLERANCE}\n`);
  const xDisplay = await crossfadeMidpointFor("display");
  const xLinear = await crossfadeMidpointFor("linear");
  console.log("");
  assert.ok(
    Math.abs(xDisplay - EXPECTED_DISPLAY) <= TOLERANCE,
    `DISPLAY arm crossfade midpoint ${xDisplay.toFixed(1)} is not ${EXPECTED_DISPLAY}±${TOLERANCE}. A ` +
      `display-referred dissolve averages the CODE values; reading ~${EXPECTED_LINEAR} means the linear mix ` +
      `is running for a project that did not ask for it, and every existing dissolve just changed.`
  );
  console.log(`  OK  display dissolve mixes CODE values  (${xDisplay.toFixed(1)} ≈ ${EXPECTED_DISPLAY} — the dark dip)`);
  assert.ok(
    Math.abs(xLinear - EXPECTED_LINEAR) <= TOLERANCE,
    `LINEAR arm crossfade midpoint ${xLinear.toFixed(1)} is not ${EXPECTED_LINEAR}±${TOLERANCE}. Reading ` +
      `~${EXPECTED_DISPLAY} means the transition mix is still on code values — the plate path can be linear ` +
      `while this one is not, which is why this probe does not reuse the blur comp.`
  );
  console.log(`  OK  linear dissolve mixes LIGHT         (${xLinear.toFixed(1)} ≈ ${EXPECTED_LINEAR})`);
  assert.ok(
    xLinear - xDisplay > 40,
    `The dissolve arms differ by only ${(xLinear - xDisplay).toFixed(1)} codes; the spaces are ~60 apart.`
  );
  console.log(`  OK  the dissolve arms are ${(xLinear - xDisplay).toFixed(1)} codes apart\n`);

  console.log(`Linear-light gate PASSED. Renders in ${path.relative(repoRoot, outDir)}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
