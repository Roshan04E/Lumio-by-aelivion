/**
 * Animated-graphic GRAPH EDITOR lanes — standalone assert script (repo convention: no test
 * framework, exits non-zero on failure).
 *
 *   pnpm --filter @kimera-by-aelivion/web graph:graphic:test
 *
 * The graph editor's contract is that a curve shows what the renderers actually render. For the
 * graphic lanes that's non-trivial: the PHASE the renderer runs is only sometimes a keyframe track
 * (Progress keys) — otherwise it's the static cycle or a Duration ramp's integral, which no track
 * holds. These checks pin the lanes to the shared resolver rather than the raw keys.
 */

import { graphicAnimationPhase, resolveGraphicAnimation, type TimelineKeyframeV2, type TimelineLayer } from "@kimera-by-aelivion/shared";
import { buildGraphicGraphTargets, graphTargetKey } from "../inspector/keyframeUtils";
import { evaluateGraphTargetValue, targetKeyframes } from "./graph-scene";

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ""}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const CYCLE = 1.2;
/** A line-md-style draw-in: fill="freeze" ⇒ plays once. */
const ANIMATED_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-dasharray="24.1" stroke-dashoffset="24.1" d="M4 12L10 18L20 6"><animate attributeName="stroke-dashoffset" values="24.1;0" dur="${CYCLE}s" fill="freeze"/></path></svg>`;
const STATIC_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 12L10 18L20 6"/></svg>`;

function key(property: string, timeSeconds: number, value: number): TimelineKeyframeV2 {
  return {
    id: `kf_${property}_${timeSeconds}`,
    target: { scope: "layer", property },
    timeSeconds,
    value,
    interpolation: "linear",
    temporal: {}
  };
}

function graphicLayer(svg: string, animations: TimelineKeyframeV2[] = []): TimelineLayer {
  return {
    id: "layer_1",
    type: "image",
    name: "Graphic",
    startSeconds: 5,
    durationSeconds: 4,
    effects: [],
    keyframes: [],
    animations,
    graphic: { svg, fill: "#5b8def", naturalWidth: 24, naturalHeight: 24 }
  } as unknown as TimelineLayer;
}

console.log("lane construction");
{
  check("a STATIC graphic contributes no lanes", buildGraphicGraphTargets(graphicLayer(STATIC_SVG)).length === 0);
  check("a non-graphic layer contributes no lanes", buildGraphicGraphTargets({ ...graphicLayer(STATIC_SVG), graphic: undefined } as TimelineLayer).length === 0);

  const targets = buildGraphicGraphTargets(graphicLayer(ANIMATED_SVG));
  check("an ANIMATED graphic contributes Progress + Duration", targets.length === 2, targets.map((t) => t.label).join(", "));
  check("both lanes are layer-scope curves", targets.every((t) => t.kind === "layer"));
  check("lane keys are distinct", new Set(targets.map(graphTargetKey)).size === 2);
}

console.log("\nProgress lane reads the resolver, not the raw track");
{
  // Keyed: play to half a cycle over 1s, then HOLD there past the natural cycle.
  const layer = graphicLayer(ANIMATED_SVG, [key("graphicProgress", 0, 0), key("graphicProgress", 1, 0.5), key("graphicProgress", 3, 0.5)]);
  const [progress] = buildGraphicGraphTargets(layer);
  const plan = resolveGraphicAnimation(layer.graphic, { animations: layer.animations });

  check("Progress keys are the lane's keyframes", targetKeyframes(layer, progress!).length === 3);
  check("lane value at t=0.5 is the keyed ramp", Math.abs(evaluateGraphTargetValue(layer, progress!, 0.5) - 0.25) < 1e-6, String(evaluateGraphTargetValue(layer, progress!, 0.5)));
  check("lane HOLDS at 0.5 past the natural cycle", Math.abs(evaluateGraphTargetValue(layer, progress!, 3) - 0.5) < 1e-6);
  check("lane agrees with the shared phase the renderers run", [0, 0.5, 1, 2, 3].every((t) => Math.abs(evaluateGraphTargetValue(layer, progress!, t) - graphicAnimationPhase(plan!, t)) < 1e-9));
}

console.log("\nun-keyed lanes still draw the truth (the base is NOT the clamp floor)");
{
  const layer = graphicLayer(ANIMATED_SVG);
  const [progress, duration] = buildGraphicGraphTargets(layer);

  // No keys anywhere: the phase comes from the STATIC cycle, so the Progress lane must still rise.
  // A lane read off the raw keyframe track would be flat 0 here.
  const early = evaluateGraphTargetValue(layer, progress!, 0.3);
  const late = evaluateGraphTargetValue(layer, progress!, 0.9);
  check("Progress rises across the static cycle", late > early, `${early.toFixed(3)} → ${late.toFixed(3)}`);

  // Duration's un-keyed base is the graphic's real cycle — NOT target.min (0.05, the drag clamp).
  const shown = evaluateGraphTargetValue(layer, duration!, 0);
  check("Duration shows the real cycle, not the clamp floor", Math.abs(shown - CYCLE) < 1e-6, `${shown}s vs min ${duration!.min}s`);
}

console.log("\nDuration ramp drives Progress with no Progress keys");
{
  const layer = graphicLayer(ANIMATED_SVG, [key("graphicDuration", 0, 1), key("graphicDuration", 2, 3)]);
  const [progress, duration] = buildGraphicGraphTargets(layer);

  check("Duration lane carries the ramp keys", targetKeyframes(layer, duration!).length === 2);
  check("Progress lane has no keys of its own", targetKeyframes(layer, progress!).length === 0);
  // The integral: the phase must still advance monotonically even though nothing keys it.
  const samples = [0, 0.5, 1, 1.5, 2].map((t) => evaluateGraphTargetValue(layer, progress!, t));
  check("Progress advances monotonically off the ramp integral", samples.every((v, i) => i === 0 || v > samples[i - 1]!), samples.map((v) => v.toFixed(3)).join(" → "));
}

console.log(failures === 0 ? "\nAll graphic graph-lane checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
