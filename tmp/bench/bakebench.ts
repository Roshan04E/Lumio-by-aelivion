/**
 * How long does ONE LUT re-bake cost on a grade tick, and how much of it is the hue/sat curves?
 * Every slider tick calls setPipeline -> bakePipelineToLut3d = 33^3 = 35937 CPU pixel evaluations.
 */
import { bakePipelineToLut3d } from "../../packages/shared/src/color/lut3d";
import type { ColorPipeline } from "../../packages/shared/src/color/types";

const neutral = () => [
  { x: 0, y: 0.5 },
  { x: 1, y: 0.5 }
];
// A realistic user curve: a few points, not the trivial 2-point line.
const shaped = () => [
  { x: 0, y: 0.5 },
  { x: 0.18, y: 0.62 },
  { x: 0.42, y: 0.45 },
  { x: 0.7, y: 0.55 },
  { x: 1, y: 0.5 }
];

const controlsOnly: ColorPipeline = {
  identity: false,
  colorSettings: { workingSpace: "rec709-linear" },
  stages: [{ controls: { exposure: 0.1, contrast: 1.1, saturation: 1.05, temperature: 0.05, tint: -0.03 } }]
} as unknown as ColorPipeline;

const withOneCurve: ColorPipeline = {
  identity: false,
  colorSettings: { workingSpace: "rec709-linear" },
  stages: [
    { controls: { exposure: 0.1, contrast: 1.1, saturation: 1.05, temperature: 0.05, tint: -0.03 } },
    { hsl: { hueVsSat: shaped() } }
  ]
} as unknown as ColorPipeline;

const withAllCurves: ColorPipeline = {
  identity: false,
  colorSettings: { workingSpace: "rec709-linear" },
  stages: [
    { controls: { exposure: 0.1, contrast: 1.1, saturation: 1.05, temperature: 0.05, tint: -0.03 } },
    {
      hsl: {
        hueVsHue: shaped(),
        hueVsSat: shaped(),
        hueVsLuma: shaped(),
        lumaVsSat: neutral(),
        satVsSat: neutral()
      }
    }
  ]
} as unknown as ColorPipeline;

function time(label: string, pipeline: ColorPipeline): number {
  bakePipelineToLut3d(pipeline); // warm
  const runs = 5;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) bakePipelineToLut3d(pipeline);
  const ms = (performance.now() - t0) / runs;
  console.log(`${label.padEnd(34)} ${ms.toFixed(1)} ms per bake`);
  return ms;
}

console.log("33^3 = 35937 nodes per bake; one bake per grade tick\n");
const a = time("controls only (no hue/sat curves)", controlsOnly);
const b = time("+ 1 hue/sat curve", withOneCurve);
const c = time("+ all 5 hue/sat curves", withAllCurves);
console.log(`\ncurve cost: ${(b - a).toFixed(1)} ms for one curve, ${(c - a).toFixed(1)} ms for five`);
