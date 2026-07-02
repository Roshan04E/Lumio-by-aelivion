/**
 * Standalone assert script for the Professional Color System engine (13C.0).
 * Repo convention: no test framework — exits non-zero on first failure.
 *
 *   pnpm --filter @lumio-by-aelivion/shared color:test
 *
 * The CPU applier is the ground truth that the SVG primitives mirror, so we test
 * the compiler + CPU path; the SVG emitter is checked structurally.
 */
import { compileColorPipeline, extractControls } from "./pipeline";
import { applyPipelineToRgb, type Rgb } from "./cpu";
import { pipelineToSvgFilter } from "./svg";
import { LUMA_WEIGHTS, TONE_LUT_SIZE, type ColorEffectInput } from "./types";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}
function approx(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

const GRAY: Rgb = [0.5, 0.5, 0.5];

function fx(type: string, params: Record<string, number>, intensity = 100): ColorEffectInput {
  return { type, params, intensity };
}

// 1. Empty / neutral → identity passthrough.
{
  const pipeline = compileColorPipeline([]);
  check("empty effects → identity", pipeline.identity && pipeline.stages.length === 0);
  const out = applyPipelineToRgb(pipeline, [0.2, 0.4, 0.6]);
  check("identity is passthrough", approx(out[0], 0.2) && approx(out[1], 0.4) && approx(out[2], 0.6));
  check("identity emits no SVG filter", pipelineToSvgFilter(pipeline, "x") === null);
}

// 2. Neutral params (saturation 100, others 0) → still identity.
{
  const pipeline = compileColorPipeline([fx("brightnessContrast", { saturation: 100, exposure: 0, contrast: 0 })]);
  check("neutral params → identity", pipeline.identity);
}

// 3. Exposure brightens; negative exposure darkens.
{
  const up = applyPipelineToRgb(compileColorPipeline([fx("brightnessContrast", { exposure: 100 })]), GRAY);
  const down = applyPipelineToRgb(compileColorPipeline([fx("brightnessContrast", { exposure: -100 })]), GRAY);
  check("exposure +100 brightens gray", up[0] > 0.5);
  check("exposure -100 darkens gray", down[0] < 0.5);
}

// 4. Saturation 0 → grayscale at correct Rec.709 luma; channels equal.
{
  const pipeline = compileColorPipeline([fx("brightnessContrast", { saturation: 0 })]);
  const out = applyPipelineToRgb(pipeline, [1, 0, 0]); // pure red
  const luma = LUMA_WEIGHTS[0];
  check("saturation 0 → channels equal (grayscale)", approx(out[0], out[1]) && approx(out[1], out[2]));
  check("saturation 0 → red maps to its luma weight", approx(out[0], luma));
}

// 5. Saturation > 100 increases channel spread vs original.
{
  const out = applyPipelineToRgb(compileColorPipeline([fx("colorGrade", { saturation: 200 })]), [0.6, 0.5, 0.4]);
  const spread = Math.max(...out) - Math.min(...out);
  check("saturation 200 widens channel spread", spread > 0.2);
}

// 6. Contrast pushes darks down and brights up around mid.
//    (exposure:0 present → modern "Basic Correction" mode, so contrast is a signed value;
//    with no modern key it would be read as the legacy 100-based neutral.)
{
  const pipeline = compileColorPipeline([fx("brightnessContrast", { contrast: 100, exposure: 0 })]);
  const dark = applyPipelineToRgb(pipeline, [0.25, 0.25, 0.25]);
  const bright = applyPipelineToRgb(pipeline, [0.75, 0.75, 0.75]);
  check("contrast lowers darks", dark[0] < 0.25);
  check("contrast raises brights", bright[0] > 0.75);
  check("contrast leaves mid ~fixed", approx(applyPipelineToRgb(pipeline, GRAY)[0], 0.5, 1e-3));
}

// 7. Temperature warms (R up, B down) on a neutral gray.
{
  const out = applyPipelineToRgb(compileColorPipeline([fx("brightnessContrast", { temperature: 100 })]), GRAY);
  check("temperature +100 raises R above B", out[0] > out[2]);
}

// 8. Intensity scales the effect toward neutral.
{
  const full = applyPipelineToRgb(compileColorPipeline([fx("brightnessContrast", { exposure: 100 }, 100)]), GRAY);
  const half = applyPipelineToRgb(compileColorPipeline([fx("brightnessContrast", { exposure: 100 }, 50)]), GRAY);
  check("intensity 50 lands between neutral and full", half[0] > 0.5 && half[0] < full[0]);
  check("intensity 0 → identity", compileColorPipeline([fx("brightnessContrast", { exposure: 100 }, 0)]).identity);
}

// 9. Unknown / non-color effects are ignored.
{
  check("blur is ignored by color engine", compileColorPipeline([fx("blur", { amount: 10 })]).identity);
}

// 10. SVG emitter shape: matrix → 20 values; curve table → TONE_LUT_SIZE values.
{
  const filter = pipelineToSvgFilter(compileColorPipeline([fx("brightnessContrast", { exposure: 40, saturation: 130 })]), "lum1");
  check("non-identity emits an SVG filter", filter !== null);
  if (filter) {
    check("filter id preserved", filter.id === "lum1");
    check("filter space is sRGB", filter.colorInterpolationFilters === "sRGB");
    const matrix = filter.primitives.find((p) => p.kind === "colorMatrix");
    const transfer = filter.primitives.find((p) => p.kind === "componentTransfer");
    check("colorMatrix has 20 values", matrix?.kind === "colorMatrix" && matrix.values.split(/\s+/).length === 20);
    check(
      "componentTransfer table has TONE_LUT_SIZE values",
      transfer?.kind === "componentTransfer" && transfer.r.split(/\s+/).length === TONE_LUT_SIZE
    );
  }
}

// 11. extractControls maps legacy 100-based brightness onto exposure.
{
  const controls = extractControls(fx("brightnessContrast", { brightness: 160 }));
  check("legacy brightness 160 → +60 exposure", approx(controls.exposure, 60));
}

// 12. Multiple color effects compose as ordered stages.
{
  const pipeline = compileColorPipeline([fx("brightnessContrast", { exposure: 30 }), fx("colorGrade", { saturation: 140 })]);
  check("two color effects → two stages", pipeline.stages.length === 2);
}

// --- 13C.1 graph curves ---------------------------------------------------
import { evaluateCurve, curvePointsToLut, channelCurvesAreIdentity } from "./curve";

// 13. Identity curve is passthrough + flagged identity.
{
  const identity = [
    { x: 0, y: 0 },
    { x: 1, y: 1 }
  ];
  check("identity curve passes mid through", approx(evaluateCurve(identity, 0.5), 0.5, 1e-3));
  check("channelCurvesAreIdentity true for identity master", channelCurvesAreIdentity({ master: identity }));
  check("colorCurves with identity → pipeline identity", compileColorPipeline([{ type: "colorCurves", params: {}, curves: { master: identity } }]).identity);
}

// 14. A monotonic S-curve: darkens lows, brightens highs, endpoints pinned, monotonic.
{
  const sCurve = [
    { x: 0, y: 0 },
    { x: 0.25, y: 0.15 },
    { x: 0.75, y: 0.85 },
    { x: 1, y: 1 }
  ];
  check("S-curve darkens the low quarter", evaluateCurve(sCurve, 0.25) < 0.25);
  check("S-curve brightens the high quarter", evaluateCurve(sCurve, 0.75) > 0.75);
  check("S-curve pins black", approx(evaluateCurve(sCurve, 0), 0));
  check("S-curve pins white", approx(evaluateCurve(sCurve, 1), 1));
  // Monotonic: sampling never decreases (Fritsch–Carlson guarantee).
  const lut = curvePointsToLut(sCurve, 64);
  let monotonic = true;
  for (let i = 1; i < lut.length; i += 1) {
    if (lut[i]! < lut[i - 1]! - 1e-6) monotonic = false;
  }
  check("S-curve LUT is monotonic (no overshoot)", monotonic);
}

// 15. colorCurves compiles to a per-channel tone stage and applies via the pipeline.
{
  const pipeline = compileColorPipeline([
    { type: "colorCurves", params: {}, curves: { master: [ { x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 } ] } }
  ]);
  check("colorCurves → one curve stage", pipeline.stages.length === 1 && pipeline.stages[0]!.curve !== null && pipeline.stages[0]!.matrix === null);
  const out = applyPipelineToRgb(pipeline, GRAY);
  check("colorCurves lifts mid gray", out[0] > 0.5 && approx(out[0], out[1]) && approx(out[1], out[2]));
}

// 16. Per-channel curve only touches its channel.
{
  const pipeline = compileColorPipeline([
    { type: "colorCurves", params: {}, curves: { blue: [ { x: 0, y: 0.2 }, { x: 1, y: 1 } ] } }
  ]);
  const out = applyPipelineToRgb(pipeline, [0.3, 0.3, 0.3]);
  check("blue-only curve raises B, leaves R/G", out[2] > 0.3 && approx(out[0], 0.3, 1e-2) && approx(out[1], 0.3, 1e-2));
}

// --- 13C.2 color wheels (ASC CDL) -----------------------------------------
import { colorWheelsToToneCurve, wheelsAreIdentity, neutralColorWheels } from "./wheels";

// 17. Neutral wheels are identity.
{
  check("neutral wheels → identity flag", wheelsAreIdentity(neutralColorWheels()));
  check("colorWheels neutral → pipeline identity", compileColorPipeline([{ type: "colorWheels", params: {}, wheels: neutralColorWheels() }]).identity);
}

// 18. Highlights master (gain) lifts the whites more than the blacks.
{
  const w = neutralColorWheels();
  w.highlights.master = 0.5; // gain up
  const pipeline = compileColorPipeline([{ type: "colorWheels", params: {}, wheels: w }]);
  check("colorWheels gain → one curve stage", pipeline.stages.length === 1 && pipeline.stages[0]!.curve !== null);
  const dark = applyPipelineToRgb(pipeline, [0.1, 0.1, 0.1]);
  const bright = applyPipelineToRgb(pipeline, [0.8, 0.8, 0.8]);
  check("gain raises a bright pixel", bright[0] > 0.8);
  check("gain affects highlights more than shadows", bright[0] - 0.8 > dark[0] - 0.1);
}

// 19. Shadows master (lift) raises the blacks.
{
  const w = neutralColorWheels();
  w.shadows.master = 0.4;
  const out = applyPipelineToRgb(compileColorPipeline([{ type: "colorWheels", params: {}, wheels: w }]), [0, 0, 0]);
  check("lift raises the black point", out[0] > 0);
}

// 20. A shadows color push tints the channels differently (color balance works).
{
  const w = neutralColorWheels();
  w.shadows = { x: 1, y: 0, master: 0 }; // push toward warm/red
  const out = applyPipelineToRgb(compileColorPipeline([{ type: "colorWheels", params: {}, wheels: w }]), [0.2, 0.2, 0.2]);
  check("shadows color push makes channels differ", Math.max(...out) - Math.min(...out) > 0.01);
}

// --- 3D LUT backbone (WebGL high-end engine foundation) -------------------
import { bakePipelineToLut3d, sampleLut3d, identityLut3d, bakeMatteLut3d } from "./lut3d";
import { lut3dToRgbaFloat } from "./shader";

// 21. Identity LUT round-trips input within trilinear precision.
{
  const lut = identityLut3d(17);
  const out = sampleLut3d(lut, [0.2, 0.5, 0.8]);
  check("identity LUT ~ passthrough", approx(out[0], 0.2, 1e-6) && approx(out[1], 0.5, 1e-6) && approx(out[2], 0.8, 1e-6));
}

// 22. A baked pipeline LUT matches the CPU pipeline at grid nodes (exact) and closely between.
{
  const pipeline = compileColorPipeline([fx("brightnessContrast", { exposure: 40, saturation: 130, temperature: 30 })]);
  const lut = bakePipelineToLut3d(pipeline, 33);
  // Exact at a grid node (33 → step 1/32; 0.5 = node 16).
  const node = applyPipelineToRgb(pipeline, [0.5, 0.5, 0.5]);
  const lutNode = sampleLut3d(lut, [0.5, 0.5, 0.5]);
  check("LUT matches CPU at a grid node", approx(lutNode[0], node[0], 1e-5) && approx(lutNode[1], node[1], 1e-5));
  // Close between nodes.
  const mid = applyPipelineToRgb(pipeline, [0.31, 0.62, 0.18]);
  const lutMid = sampleLut3d(lut, [0.31, 0.62, 0.18]);
  check("LUT ~ CPU between nodes (trilinear)", Math.abs(lutMid[0] - mid[0]) < 0.02 && Math.abs(lutMid[2] - mid[2]) < 0.02);
}

// 23. A curves pipeline also bakes correctly (lifts mid gray).
{
  const lut = bakePipelineToLut3d(
    compileColorPipeline([{ type: "colorCurves", params: {}, curves: { master: [ { x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 } ] } }]),
    33
  );
  check("curves LUT lifts mid gray", sampleLut3d(lut, [0.5, 0.5, 0.5])[0] > 0.5);
}

// 24. RGBA float packing + sampling uniforms are well-formed.
{
  const lut = identityLut3d(8);
  const rgba = lut3dToRgbaFloat(lut);
  check("packed RGBA length = size³·4", rgba.length === 8 * 8 * 8 * 4);
  check("packed alpha = 1", rgba[3] === 1 && rgba[rgba.length - 1] === 1);
}

// ---------------------------------------------------------------- 13C.3 HSL ops
import { rgbToHsl, hslToRgb, applyHueSatCurves, applySecondary, secondaryKey, hueSatCurvesAreIdentity, secondaryIsIdentity, NEUTRAL_SECONDARY, type HslSecondary } from "./hsl";

// 25. RGB↔HSL round-trips across a spread of colors (incl. gray + saturated primaries).
{
  const samples: Rgb[] = [
    [0.2, 0.4, 0.6],
    [0.9, 0.1, 0.1],
    [0.1, 0.8, 0.3],
    [0.5, 0.5, 0.5],
    [0.0, 0.0, 0.0],
    [1.0, 1.0, 1.0],
    [0.7, 0.7, 0.2]
  ];
  let worst = 0;
  for (const c of samples) {
    const [h, s, l] = rgbToHsl(c);
    const back = hslToRgb(h, s, l);
    worst = Math.max(worst, Math.abs(back[0] - c[0]), Math.abs(back[1] - c[1]), Math.abs(back[2] - c[2]));
  }
  check("rgb↔hsl round-trips", worst < 1e-4);
}

// 26. Flat (0.5) hue/sat curves are identity; bumping hueVsSat raises saturation of that hue.
{
  check("flat hue/sat curves → identity", hueSatCurvesAreIdentity({ hueVsSat: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] }));
  // A reddish pixel; push saturation UP only around red (hue≈0).
  const red: Rgb = [0.6, 0.3, 0.3];
  const before = rgbToHsl(red)[1];
  const out = applyHueSatCurves({ hueVsSat: [{ x: 0, y: 0.85 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.85 }] }, red);
  const after = rgbToHsl(out)[1];
  check("hueVsSat raises saturation of the targeted hue", after > before + 0.02);
}

// 27. hueVsHue shifts hue; a green push leaves a far-off (blue) pixel about where it was.
{
  const green: Rgb = hslToRgb(1 / 3, 0.6, 0.5);
  const shifted = applyHueSatCurves({ hueVsHue: [{ x: 0, y: 0.5 }, { x: 1 / 3, y: 0.7 }, { x: 1, y: 0.5 }] }, green);
  check("hueVsHue moves the targeted hue", Math.abs(rgbToHsl(shifted)[0] - 1 / 3) > 0.02);
}

// 28. Secondary key: a tight red key selects red strongly and rejects blue.
{
  const sec: HslSecondary = { ...NEUTRAL_SECONDARY, hueCenter: 0, hueWidth: 0.06, softness: 0.05 };
  const red = hslToRgb(0, 0.8, 0.5);
  const blue = hslToRgb(2 / 3, 0.8, 0.5);
  check("secondary keys the in-range hue", secondaryKey(sec, red) > 0.9);
  check("secondary rejects the out-of-range hue", secondaryKey(sec, blue) < 0.05);
}

// 29. Secondary correction only touches keyed pixels (blue untouched when keying red).
{
  const sec: HslSecondary = { ...NEUTRAL_SECONDARY, hueCenter: 0, hueWidth: 0.06, softness: 0.05, satScale: 0 };
  const blue = hslToRgb(2 / 3, 0.8, 0.5);
  const out = applySecondary(sec, blue);
  check("secondary leaves non-keyed pixels unchanged", approx(out[0], blue[0], 1e-3) && approx(out[2], blue[2], 1e-3));
  const red = hslToRgb(0, 0.8, 0.5);
  const desat = applySecondary(sec, red);
  check("secondary desaturates the keyed pixel (satScale 0)", rgbToHsl(desat)[1] < 0.1);
  check("neutral secondary → identity", secondaryIsIdentity(NEUTRAL_SECONDARY));
}

// 30. HSL stages bake into the 3D LUT (the WebGL path) — secondary desat shows up.
{
  const sec: HslSecondary = { ...NEUTRAL_SECONDARY, hueCenter: 0, hueWidth: 0.08, softness: 0.06, satScale: 0 };
  const pipeline = compileColorPipeline([{ type: "hslSecondary", params: {}, secondary: sec }]);
  check("secondary pipeline is not identity", !pipeline.identity && pipeline.stages.length === 1);
  const lut = bakePipelineToLut3d(pipeline, 33);
  const red = hslToRgb(0, 0.85, 0.5);
  const out = sampleLut3d(lut, red);
  check("LUT desaturates keyed red", rgbToHsl(out as Rgb)[1] < rgbToHsl(red)[1] - 0.1);
}

// 31. showMask surfaces previewMatte without forcing a grade stage.
{
  const sec: HslSecondary = { ...NEUTRAL_SECONDARY, hueCenter: 0.33, hueWidth: 0.1, showMask: true };
  const pipeline = compileColorPipeline([{ type: "hslSecondary", params: {}, secondary: sec }]);
  check("showMask sets previewMatte", Boolean(pipeline.previewMatte) && pipeline.stages.length === 0 && !pipeline.identity);
  const matte = bakeMatteLut3d(sec, 33);
  const green = hslToRgb(0.33, 0.8, 0.5);
  const blue = hslToRgb(2 / 3, 0.8, 0.5);
  check("matte LUT is bright on keyed, dark off-key", sampleLut3d(matte, green)[0] > 0.7 && sampleLut3d(matte, blue)[0] < 0.2);
}

if (failures > 0) {
  console.error(`\n${failures} color test(s) failed.`);
  process.exit(1);
}
console.log("\nAll color engine tests passed.");
