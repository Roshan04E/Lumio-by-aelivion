/**
 * Animated (SMIL) vector graphic — REAL Remotion render verification (no test framework; exits non-zero
 * on failure). CLAUDE.md: prefer render:manifest against the real renderer over trusting typecheck.
 *
 * Renders stills at several points of an animated graphic's cycle through the ACTUAL Remotion renderer
 * and asserts the pixels advance (the SMIL deep-link is playing) and loop (t=cycle ≡ t=0). Without the
 * per-frame `graphicToAnimatedDataUrl` src in SceneStage, every frame would be the settled final frame
 * and the "frames advance" checks would fail.
 *
 * Run: pnpm --filter @orreris/worker graphic:render
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderManifest } from "@orreris/render-templates";
import { getGraphicAnimationCycleSeconds, resolveGraphicAnimation, type GraphicLoopMode, type ProjectGraph, type TimelineKeyframeV2 } from "@orreris/shared";
import { PNG } from "pngjs";
import { renderManifestStill } from "./remotion-renderer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDir = path.join(repoRoot, "tmp", "graphic-animation");

const FPS = 30;
const CYCLE = 1.2; // matches the draw-in `dur` below
// A line-md-style draw-in: the base state is INVISIBLE (dashoffset hides the stroke) and the animation
// draws it in — exactly the class of icon the settle workaround existed for.
// dasharray ≈ the path's real length (8.49 + 15.62 ≈ 24.1) so the draw-in spans the WHOLE dur. With a
// dasharray far longer than the path the stroke completes early and the tail of the cycle is static —
// which silently weakens "coverage grows across the cycle".
const DRAW_IN_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke-dasharray="24.1" stroke-dashoffset="24.1" d="M4 12L10 18L20 6"><animate attributeName="stroke-dashoffset" values="24.1;0" dur="${CYCLE}s" fill="freeze"/></path></g></svg>`;

function graph(animation?: { loop?: GraphicLoopMode; durationSeconds?: number }, animations?: TimelineKeyframeV2[]): ProjectGraph {
  return {
    projectId: "project_graphic_animation",
    effects: [],
    editableFields: {},
    version: 1,
    composition: {
      id: "composition_graphic_animation",
      name: "Animated graphic",
      width: 512,
      height: 512,
      fps: FPS,
      durationSeconds: 4,
      backgroundColor: "#000000",
      tracks: [
        {
          id: "overlay_track",
          type: "overlay",
          name: "Overlay",
          layers: [
            {
              id: "graphic_layer",
              type: "image",
              name: "Animated graphic",
              startSeconds: 0,
              durationSeconds: 4,
              effects: [],
              fit: "contain",
              animations,
              graphic: { svg: DRAW_IN_SVG, fill: "#5b8def", naturalWidth: 24, naturalHeight: 24, animation }
            }
          ]
        }
      ]
    }
  } as unknown as ProjectGraph;
}

function readPixels(file: string): { data: Buffer; width: number; height: number } {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { data: png.data, width: png.width, height: png.height };
}

/** Mean absolute per-channel difference (0..255) between two same-size PNGs. */
function meanDiff(a: string, b: string): number {
  const pa = readPixels(a);
  const pb = readPixels(b);
  if (pa.width !== pb.width || pa.height !== pb.height) throw new Error("still size mismatch");
  let sum = 0;
  for (let i = 0; i < pa.data.length; i += 1) sum += Math.abs(pa.data[i]! - pb.data[i]!);
  return sum / pa.data.length;
}

/** Fraction of non-transparent, non-black pixels — how much of the icon is drawn in. */
function inkCoverage(file: string): number {
  const { data } = readPixels(file);
  let ink = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! > 16 && (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16)) ink += 1;
  }
  return ink / pixels;
}

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ""}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  console.log(`cycle detected from SVG: ${getGraphicAnimationCycleSeconds(DRAW_IN_SVG)}s (expected ${CYCLE}s)`);

  const manifest = buildRenderManifest({
    projectId: "project_graphic_animation",
    graph: graph(),
    assets: [],
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const layer = manifest.layers.find((l) => l.id === "graphic_layer");
  const plan = resolveGraphicAnimation(layer?.graphic);
  console.log("manifest carries the graphic; resolved plan:", plan);

  // Sample across ONE cycle, plus one full cycle later to prove looping.
  const samples = [0, 0.25, 0.5, 0.9, CYCLE] as const;
  const files: string[] = [];
  for (const t of samples) {
    const frame = Math.round(t * FPS);
    const out = path.join(artifactDir, `remotion-graphic-t${String(t).replace(".", "_")}.png`);
    console.log(`[still] t=${t}s (frame ${frame}) -> ${path.relative(repoRoot, out)}`);
    await renderManifestStill({ manifest, frame, outputLocation: out, rendererMode: "webgl" });
    files.push(out);
  }

  console.log("\nmanifest");
  check("graphic threaded onto the manifest layer", Boolean(layer?.graphic));
  check("plan resolves from the manifest graphic", plan?.naturalCycleSeconds === CYCLE, String(plan?.naturalCycleSeconds));
  check("draw-in defaults to PLAY ONCE (author's fill=freeze)", plan?.loop === false);

  console.log("\nrendered frames advance (animation is PLAYING, not settled)");
  const coverage = files.map(inkCoverage);
  samples.forEach((t, i) => console.log(`    t=${t}s ink coverage ${(coverage[i]! * 100).toFixed(2)}%`));
  // The draw-in starts hidden and fills in: coverage must grow across the cycle.
  // Relative to the COMPLETED icon, not an absolute floor: the base state still paints the stroke's
  // round line-cap (a dot), so "empty" is "a small fraction of the finished ink", not literally zero.
  check("t=0 is (near) empty — base state, animation at its start", coverage[0]! < coverage[4]! * 0.1, `${(coverage[0]! * 100).toFixed(2)}% vs ${(coverage[4]! * 100).toFixed(2)}% complete`);
  check("coverage grows 0 → 0.25s", coverage[1]! > coverage[0]!);
  check("coverage grows 0.25 → 0.5s", coverage[2]! > coverage[1]!);
  check("coverage grows 0.5 → 0.9s", coverage[3]! > coverage[2]!);
  check("consecutive frames differ", meanDiff(files[0]!, files[1]!) > 0.1 && meanDiff(files[1]!, files[2]!) > 0.1);

  // AUTHOR INTENT: a fill="freeze" draw-in must HOLD its completed frame past the cycle — NOT restart.
  // Forcing repeatCount="indefinite" (the old behavior) made it blank out and redraw here instead.
  console.log("\nplay-once holds the completed frame (author's fill=freeze honored)");
  console.log(`    t=${CYCLE}s ink coverage ${(coverage[4]! * 100).toFixed(2)}%`);
  // `>=` (with tolerance), not `>`: a draw-in that finishes exactly at its dur is complete at both
  // samples. The point is that it HOLDS the completed icon rather than blanking out and restarting.
  check("t=cycle holds the COMPLETED icon, not a restart", coverage[4]! >= coverage[3]! * 0.99, `${(coverage[4]! * 100).toFixed(2)}% vs ${(coverage[3]! * 100).toFixed(2)}%`);
  check("t=cycle is NOT blank (would mean it looped)", coverage[4]! > 0.05);

  // And with loop forced infinite, the SAME graphic must wrap back to the empty base state at t=cycle.
  console.log("\nloop override wraps back to the start");
  const loopManifest = buildRenderManifest({
    projectId: "project_graphic_animation",
    graph: graph({ loop: "infinite" }),
    assets: [],
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const loopOut = path.join(artifactDir, "remotion-graphic-loop-t1_2.png");
  await renderManifestStill({ manifest: loopManifest, frame: Math.round(CYCLE * FPS), outputLocation: loopOut, rendererMode: "webgl" });
  const loopCoverage = inkCoverage(loopOut);
  console.log(`    loop=infinite, t=${CYCLE}s ink coverage ${(loopCoverage * 100).toFixed(2)}%`);
  check("loop=infinite wraps to the base state at t=cycle", loopCoverage < coverage[4]! * 0.1, `${(loopCoverage * 100).toFixed(2)}% vs ${(coverage[4]! * 100).toFixed(2)}% complete`);
  check("loop=infinite t=cycle is pixel-identical to t=0", meanDiff(files[0]!, loopOut) < 0.5);
  // The two modes must genuinely DIVERGE at t=cycle — same graphic, same frame, opposite outcomes.
  check("once vs infinite diverge at t=cycle", meanDiff(files[4]!, loopOut) > 1, `meanDiff=${meanDiff(files[4]!, loopOut).toFixed(2)}`);

  // KEYFRAMED progress: the phase is driven entirely by keys. Hold the draw-in HALF-drawn well past its
  // natural 1.2s cycle — impossible with the static/duration paths, so it proves the keys are in control
  // end-to-end (manifest → SceneStage → real render), not just in the shared math.
  console.log("\nprogress keyframes drive the phase (real render)");
  const keyedManifest = buildRenderManifest({
    projectId: "project_graphic_animation",
    graph: graph(undefined, [
      { id: "k0", target: { scope: "layer", property: "graphicProgress" }, timeSeconds: 0, value: 0, interpolation: "linear", temporal: {} },
      { id: "k1", target: { scope: "layer", property: "graphicProgress" }, timeSeconds: 1, value: 0.5, interpolation: "linear", temporal: {} },
      { id: "k2", target: { scope: "layer", property: "graphicProgress" }, timeSeconds: 3, value: 0.5, interpolation: "linear", temporal: {} }
    ]),
    assets: [],
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const keyedFiles: string[] = [];
  for (const t of [1, 3] as const) {
    const out = path.join(artifactDir, `remotion-graphic-keyed-t${t}.png`);
    await renderManifestStill({ manifest: keyedManifest, frame: Math.round(t * FPS), outputLocation: out, rendererMode: "webgl" });
    keyedFiles.push(out);
  }
  const keyedCoverage = keyedFiles.map(inkCoverage);
  console.log(`    keyed t=1s ink ${(keyedCoverage[0]! * 100).toFixed(2)}%   keyed t=3s ink ${(keyedCoverage[1]! * 100).toFixed(2)}%`);
  check("keyed progress=0.5 renders the icon HALF drawn", keyedCoverage[0]! > coverage[0]! && keyedCoverage[0]! < coverage[4]! * 0.9, `${(keyedCoverage[0]! * 100).toFixed(2)}%`);
  check("keyed progress HOLDS at 0.5 past the natural cycle", meanDiff(keyedFiles[0]!, keyedFiles[1]!) < 0.5);
  check("keyed t=3s differs from the un-keyed completed icon", meanDiff(keyedFiles[1]!, files[4]!) > 1);

  console.log(failures === 0 ? "\nAll Remotion animated-graphic checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
