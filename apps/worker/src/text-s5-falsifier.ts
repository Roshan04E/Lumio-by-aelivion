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

  // --- S5b: the image fill, now an asset REFERENCE ---------------------------------------------
  //
  // The arm that matters most is `unresolvable`. S5b moved the fill from a URL on the layer to an id
  // the renderer resolves, so the new way for this feature to break is a resolution step that quietly
  // answers nothing — and a fill that resolves to nothing paints the solid colour, which is the same
  // picture as no fill at all. That is the intended degradation (D3: the EDITOR names it, the renderer
  // does not guess), and it is also indistinguishable from the feature being dead. So it is asserted
  // in both directions: a resolvable id must differ from no fill, and an unresolvable one must not.
  const fillOn = await renderWith("texture-fill", "fill-on", {});
  const fillOff = await renderWith("texture-fill", "fill-off", { fillTextureAssetId: undefined });
  const fillUnresolvable = await renderWith("texture-fill", "fill-unresolvable", { fillTextureAssetId: "no_such_asset" });
  const fillCover = await renderWith("texture-fill", "fill-cover", { fillTextureFit: "cover" });
  const fillScaled = await renderWith("texture-fill", "fill-scale-4", { fillTextureScale: 4 });
  process.stdout.write(
    `fill       on=${short(fillOn)}  off=${short(fillOff)}  unresolvable=${short(fillUnresolvable)}  cover=${short(fillCover)}  scale4=${short(fillScaled)}\n\n`
  );

  /**
   * --- S8: the concentric outer ring -----------------------------------------------------------
   *
   * Written against T-15 addendum 3, because the naive arm here is a textbook difference-fails-open.
   * "Ring on vs ring off differs" is satisfied by any perturbation, and the ring has three separate
   * ways to move the render for reasons that are NOT the feature working: the raster's overhang
   * margin widens with the outer width (so the box changes size), the emitted style is part of the
   * raster's cache key, and the manifest bag gains keys. So each arm below names what the two sides
   * SHARE, and the pair that carries the stage is `ringColorA` vs `ringColorB` — identical in every
   * one of those three respects, differing only in the ring's COLOUR, which nothing but a ring
   * actually being painted can express.
   */
  const ringOn = await renderWith("multi-stroke", "ring-on", {});
  const ringOff = await renderWith("multi-stroke", "ring-off", {
    strokeOuterColor: undefined,
    strokeOuterWidth: undefined
  });
  // Same width, same box, same key length — only the colour differs.
  const ringColorB = await renderWith("multi-stroke", "ring-color-b", { strokeOuterColor: "#00e5ff" });
  // NARROWER than the inner stroke: `resolveOuterStroke` refuses it, so this must be byte-identical
  // to no ring at all. Without this arm, "the ring is drawn whenever the keys are present" passes.
  const ringNarrow = await renderWith("multi-stroke", "ring-narrower-than-inner", { strokeOuterWidth: 8 });
  // A ring with NO INNER STROKE to ring. Also refused, and it must collapse onto the same picture as
  // the same layer with the ring keys deleted — not merely differ from the subject.
  const ringNoInner = await renderWith("multi-stroke", "ring-no-inner", { strokeWidth: 0 });
  const ringNoInnerNoRing = await renderWith("multi-stroke", "ring-no-inner-no-ring", {
    strokeWidth: 0,
    strokeOuterColor: undefined,
    strokeOuterWidth: undefined
  });
  process.stdout.write(
    `ring       on=${short(ringOn)}  off=${short(ringOff)}  colorB=${short(ringColorB)}  narrow=${short(ringNarrow)}  ` +
      `no-inner=${short(ringNoInner)}  no-inner-no-ring=${short(ringNoInnerNoRing)}\n\n`
  );

  /**
   * --- S8: text on a path ----------------------------------------------------------------------
   *
   * The subject arm is honest here in a way the ring's was not, because a curve moves the glyphs
   * themselves rather than adding ink around them — but the same addendum-3 discipline still
   * applies to the CONTROLS, which are the interesting half. `curve-below-threshold` proves the
   * refusal is a refusal (byte-identical to straight, not merely different from the subject), and
   * `curve-up` vs `curve-down` share every size, margin and key length and differ only in the SIGN,
   * which nothing but the arc actually bending can express.
   */
  const curveOn = await renderWith("path-text", "curve-on", {});
  const curveOff = await renderWith("path-text", "curve-off", { textPathCurve: undefined });
  const curveDown = await renderWith("path-text", "curve-down", { textPathCurve: -55 });
  const curveTiny = await renderWith("path-text", "curve-below-threshold", { textPathCurve: 0.4 });
  // Warp wins when both are set — asserted as an EQUALITY against the same layer with no curve at
  // all, so "warp wins" means the curve contributed nothing, not merely that the picture differs.
  const curveAndWarp = await renderWith("path-text", "curve-and-warp", {
    textWarp: { style: "arc", bend: 40, distortH: 0, distortV: 0 }
  });
  const warpOnly = await renderWith("path-text", "warp-only", {
    textPathCurve: undefined,
    textWarp: { style: "arc", bend: 40, distortH: 0, distortV: 0 }
  });
  process.stdout.write(
    `curve      on=${short(curveOn)}  off=${short(curveOff)}  down=${short(curveDown)}  ` +
      `below-threshold=${short(curveTiny)}  curve+warp=${short(curveAndWarp)}  warp-only=${short(warpOnly)}\n\n`
  );

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

  assert.notEqual(
    fillOn,
    fillOff,
    "FALSIFIER FAILED — removing `fillTextureAssetId` produced a BYTE-IDENTICAL render. The image fill " +
      "is not reaching the renderer: check that MANIFEST_LAYER_STYLE_KEYS carries the three fields, that " +
      "`buildRenderManifest` adds the fill's asset id to `referencedAssetIds` (it is NOT the layer's own " +
      "`assetId`, so the manifest would otherwise ship a reference to an asset it does not carry), and " +
      "that SceneStage hands `resolveAssetUrl` to the rasterizer."
  );
  assert.equal(
    fillUnresolvable,
    fillOff,
    "CONTROL FAILED — an UNRESOLVABLE asset id rendered differently from no fill at all. A fill that " +
      "cannot be resolved must paint the layer's own colour and nothing else; anything else means the " +
      "renderer is inventing a picture for a reference it could not answer."
  );
  assert.notEqual(
    fillCover,
    fillOn,
    "FALSIFIER FAILED — `fillTextureFit` changed nothing. The enum is not reaching `fillTexturePaint`."
  );
  assert.notEqual(
    fillScaled,
    fillOn,
    "FALSIFIER FAILED — `fillTextureScale` changed nothing. The number is not reaching `fillTexturePaint`."
  );

  assert.notEqual(
    ringOn,
    ringOff,
    "FALSIFIER FAILED — removing the outer stroke produced a BYTE-IDENTICAL render. The ring is not " +
      "reaching the renderer: check MANIFEST_LAYER_STYLE_KEYS carries strokeOuterColor/Width, that " +
      "`getCompositionTextStyle` emits `textOuterStroke`, and that drawTextLayer's `strokeRings` runs."
  );
  assert.notEqual(
    ringColorB,
    ringOn,
    "FALSIFIER FAILED — changing only the ring's COLOUR changed nothing. This is the arm that carries " +
      "the stage: the two renders share the ring WIDTH, so they share the raster's overhang margin, its " +
      "box size and its cache-key length, and the only thing left that can move the picture is a ring " +
      "actually being painted in the colour it was given. `ring-on` vs `ring-off` alone would have been " +
      "satisfied by any one of those three perturbations (T-15 addendum 3)."
  );
  assert.equal(
    ringNarrow,
    ringOff,
    "CONTROL FAILED — a ring NARROWER than the stroke it surrounds rendered differently from no ring. " +
      "`resolveOuterStroke` refuses it because the inner stroke covers it completely, so the picture must " +
      "be identical; if it is not, either the refusal is not happening or the ring is being drawn after " +
      "the inner stroke rather than before it."
  );
  assert.equal(
    ringNoInner,
    ringNoInnerNoRing,
    "CONTROL FAILED — an outer ring with NO INNER STROKE to ring rendered as something. A ring around " +
      "nothing is a stroke, which `strokeWidth` already is, so `resolveOuterStroke` refuses it; rendering " +
      "it would give the layer a second way to say something it can already say, reachable only by accident."
  );

  assert.notEqual(
    curveOn,
    curveOff,
    "FALSIFIER FAILED — removing `textPathCurve` produced a BYTE-IDENTICAL render. Text on a path is " +
      "not reaching the renderer: check MANIFEST_LAYER_STYLE_KEYS carries textPathCurve, that " +
      "`getCompositionTextStyle` emits it, and that drawTextLayer's arc branch is reached (warp is " +
      "checked first and wins, so a stray textWarp on the fixture would also produce this)."
  );
  assert.notEqual(
    curveDown,
    curveOn,
    "FALSIFIER FAILED — flipping the curve's SIGN changed nothing. This is the arm that carries the " +
      "feature: the two renders share the text, the font, both rings, the raster margin and the key " +
      "length, so the only thing left that can move the picture is the arc bending the other way."
  );
  assert.equal(
    curveTiny,
    curveOff,
    "CONTROL FAILED — a curve below the straight-line threshold rendered differently from no curve. " +
      "Below MIN_TEXT_PATH_CURVE the arc's radius runs away toward infinity, so it resolves to 0; if " +
      "this differs, the threshold is not being applied and a user dragging the slider through zero " +
      "gets a jump instead of a straight line."
  );
  assert.equal(
    curveAndWarp,
    warpOnly,
    "CONTROL FAILED — a layer carrying BOTH a warp and a curve did not render as warp alone. Warp wins " +
      "(see TimelineLayer.textPathCurve), and it is enforced by the warp branch returning first; a " +
      "difference here means the two geometries are composing in some order nobody decided."
  );

  process.stdout.write("PASS — all three S5 fields change the render, and all three no-op arms are byte-identical.\n");
  process.stdout.write("PASS — the S8 arc bends, its SIGN alone moves the render, a sub-threshold curve is straight, and warp wins over a curve.\n");
  process.stdout.write("PASS — the S8 ring paints, its COLOUR alone moves the render, and both refusal cases are byte-identical to no ring.\n");
  process.stdout.write("PASS — the S5b image fill resolves, its fit and scale move, and an unresolvable id degrades to the solid colour.\n");
  process.stdout.write(`stills: ${outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
