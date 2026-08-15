/**
 * ADR-023 T-15 — flip the field and prove the RENDER changes. S5's three fields.
 *
 * WHY, in one sentence: `render:compare:pixels` compares two consumers of the same manifest bag, so it
 * cannot detect a field that never reached the bag — both renderers agree, at 0.000%, about an answer
 * neither of them was given. S1 shipped within one commit of exactly that. S5's three fixtures each
 * came back at 0.000% on their first run, which is precisely the report a completely inert feature
 * would also produce, so none of them means anything until it is falsified here.
 *
 * SUBJECTS — the three S5 fixtures, each rendered with its S5 look ON and OFF. The two renders MUST
 * differ. The "off" arm is the LEGACY shape (the key absent, not set to a falsy value), so a passing
 * subject also demonstrates the D1a claim from the render side: absent renders as it did before.
 *
 * CONTROLS — the SAME flip applied to a fixture that has no business responding to it:
 *
 *   - gradient      → a layer with only ONE stop. Half-authored is not a gradient (`resolveFillGradient`),
 *                     so it must render byte-identically to no gradient at all. Without this arm, the
 *                     subject's difference is equally consistent with "any gradient field at all
 *                     perturbs the raster", e.g. through the cache key, which would make the gate green
 *                     for the wrong reason.
 *   - per-line pill → the pill switched on over a TRANSPARENT background. The emitted style is asserted
 *                     byte-identical in `textstyle:schema`; this proves the PIXELS are too, which is the
 *                     no-op half of the feature and the half a refactor would quietly break.
 *   - shadow stack  → `shadowLayers: 1` against absent. One copy IS the legacy declaration, so a
 *                     difference here would mean the stack path is not byte-identical at its identity
 *                     value and every existing project with a shadow just moved.
 *
 * Run: pnpm --filter @orreris/worker text:s5-falsifier
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
const outDir = path.join(repoRoot, "tmp", "text-s5-falsifier");

/** Fields to force onto every text layer. `undefined` DELETES the key — the legacy shape, not "off". */
type Override = Partial<Record<keyof TimelineLayer, unknown>>;

/**
 * Render a fixture with `override` applied to every text layer, and hash the PNG.
 *
 * Applied to the fixture graph rather than through a second fixture key, so both arms are provably the
 * same composition differing in exactly the fields named — which is the whole claim.
 */
async function renderWith(key: RenderComparisonFixtureKey, label: string, override: Override): Promise<string> {
  const fixture = createRenderComparisonFixture(key);
  const composition = fixture.graph.composition;
  if (!composition) throw new Error(`Fixture "${key}" must include a composition.`);

  let touched = 0;
  const applyTo = (layer: TimelineLayer): TimelineLayer => {
    touched += 1;
    const next = { ...layer } as Record<string, unknown>;
    for (const [field, value] of Object.entries(override)) {
      // `delete` rather than `= undefined`: the manifest bag copies keys unconditionally, and this
      // gate's whole subject is the difference between a key that is absent and one that is present.
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
  // A run that overrode nothing would compare a fixture with itself and pass forever.
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

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "text:s5-falsifier", scriptMarker: "text-s5-falsifier" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);
  fs.mkdirSync(outDir, { recursive: true });

  // --- gradient fill ---------------------------------------------------------------------------
  const gradientOn = await renderWith("gradient-fill", "gradient-on", {});
  const gradientOff = await renderWith("gradient-fill", "gradient-off", {
    fillGradientFrom: undefined,
    fillGradientTo: undefined,
    fillGradientAngle: undefined
  });
  const gradientHalf = await renderWith("gradient-fill", "gradient-half", { fillGradientTo: undefined });
  const gradientAngled = await renderWith("gradient-fill", "gradient-angle-135", { fillGradientAngle: 135 });
  process.stdout.write(
    `gradient   on=${short(gradientOn)}  off=${short(gradientOff)}  one-stop=${short(gradientHalf)}  angle135=${short(gradientAngled)}\n`
  );

  // --- per-line pill ---------------------------------------------------------------------------
  const pillOn = await renderWith("per-line-pill", "pill-on", {});
  const pillOff = await renderWith("per-line-pill", "pill-off", { backgroundPerLine: undefined });
  const pillTransparent = await renderWith("per-line-pill", "pill-transparent-on", { backgroundColor: "transparent" });
  const pillTransparentOff = await renderWith("per-line-pill", "pill-transparent-off", {
    backgroundColor: "transparent",
    backgroundPerLine: undefined
  });
  process.stdout.write(
    `pill       on=${short(pillOn)}  off=${short(pillOff)}  transparent-on=${short(pillTransparent)}  transparent-off=${short(pillTransparentOff)}\n`
  );

  // --- stacked shadows -------------------------------------------------------------------------
  const stackOn = await renderWith("shadow-stack", "stack-on", {});
  const stackOff = await renderWith("shadow-stack", "stack-off", { shadowLayers: undefined });
  const stackOne = await renderWith("shadow-stack", "stack-one", { shadowLayers: 1 });
  process.stdout.write(`stack      on=${short(stackOn)}  absent=${short(stackOff)}  layers1=${short(stackOne)}\n\n`);

  // --- the assertions --------------------------------------------------------------------------
  assert.notEqual(
    gradientOn,
    gradientOff,
    "FALSIFIER FAILED — removing both gradient stops produced a BYTE-IDENTICAL render. The gradient is " +
      "not reaching the renderer: check MANIFEST_LAYER_STYLE_KEYS carries fillGradientFrom/To/Angle and " +
      "that drawTextLayer's glyphPaint falls through to fillGradientPaint. render:compare:pixels cannot " +
      "see this — it compares two consumers of the same bag."
  );
  assert.equal(
    gradientHalf,
    gradientOff,
    "CONTROL FAILED — a ONE-STOP gradient rendered differently from no gradient. `resolveFillGradient` " +
      "requires both stops, so a half-authored gradient must be invisible; if it is not, the subject's " +
      "difference above may be a cache-key perturbation rather than a gradient being painted."
  );
  assert.notEqual(
    gradientAngled,
    gradientOn,
    "FALSIFIER FAILED — changing the gradient ANGLE changed nothing. The angle is reaching neither the " +
      "declaration nor the canvas gradient line (fillGradientPaint)."
  );

  assert.notEqual(
    pillOn,
    pillOff,
    "FALSIFIER FAILED — removing `backgroundPerLine` produced a BYTE-IDENTICAL render of two lines of " +
      "very different length. The per-line pill is not reaching the renderer: check the manifest bag and " +
      "drawTextLayer's linePill draw."
  );
  assert.equal(
    pillTransparent,
    pillTransparentOff,
    "CONTROL FAILED — asking for per-line pills over a TRANSPARENT background changed the picture. That " +
      "case must be a no-op in pixels as well as in the emitted style (ADR-023 D1a), or every pill-less " +
      "layer that ever gets the flag set moves."
  );

  assert.notEqual(
    stackOn,
    stackOff,
    "FALSIFIER FAILED — removing `shadowLayers` produced a BYTE-IDENTICAL render of an 8-copy extrude. " +
      "The stack is not reaching the renderer: check the manifest bag, textShadowCss's list emission, and " +
      "drawTextLayer's extra shadow passes."
  );
  assert.equal(
    stackOne,
    stackOff,
    "CONTROL FAILED — `shadowLayers: 1` rendered differently from the field being absent. One copy IS the " +
      "pre-S5 declaration, so this means the stack path is not byte-identical at its identity value and " +
      "every existing project carrying a shadow has moved."
  );

  process.stdout.write("PASS — all three S5 fields change the render, and all three no-op arms are byte-identical.\n");
  process.stdout.write(`stills: ${outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
