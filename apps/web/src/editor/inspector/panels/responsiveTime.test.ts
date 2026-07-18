/**
 * Standalone assert script for Responsive Time (§5). Repo convention: no test framework — exits
 * non-zero on first failure.
 *
 *   pnpm --filter @orreris/web resp-time:test
 *
 * Covers the pure re-time (remapResponsiveTime) and the region-aware squeeze integration
 * (squeezeLayerKeyframesTo with layer.responsiveTime).
 */
import { remapResponsiveTime, squeezeLayerKeyframesTo, type TimelineKeyframeV2, type TimelineLayer } from "@orreris/shared";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;

// A 5s clip: fade-in ends 0.5, middle keyframe 2.5, fade-out starts 4.5, ends 5.0.
// Protect intro 0.5 / outro 0.5, stretch to 10s.
{
  const remap = (t: number) => remapResponsiveTime(t, 5, 10, 0.5, 0.5);
  check("head 0 held", near(remap(0), 0));
  check("head 0.5 held (intro edge)", near(remap(0.5), 0.5));
  check("middle 2.5 → scaled", near(remap(2.5), 0.5 + (2.0 / 4.0) * 9.0)); // (2.5-0.5)/4 * 9 + 0.5 = 5.0
  check("tail 4.5 re-anchored (outro edge)", near(remap(4.5), 10 - (5 - 4.5))); // 9.5
  check("tail 5.0 re-anchored to new end", near(remap(5.0), 10.0));
}

// Shrinking 5s → 2s keeps intro/outro, squeezes the middle.
{
  const remap = (t: number) => remapResponsiveTime(t, 5, 2, 0.5, 0.5);
  check("shrink: head 0.5 held", near(remap(0.5), 0.5));
  check("shrink: tail 4.5 → 1.5 (new end 2 − 0.5)", near(remap(4.5), 1.5));
  check("shrink: middle 2.5 → 1.0 (center of 1s middle)", near(remap(2.5), 0.5 + (2.0 / 4.0) * 1.0));
}

// Fit-guard: protected zones don't fit → proportional fallback.
{
  // intro+outro (0.5+0.5=1) ≥ min(oldDur,newDur)=0.8 → proportional.
  const t = remapResponsiveTime(0.4, 5, 0.8, 0.5, 0.5);
  check("fit-guard: falls back to proportional", near(t, 0.4 * (0.8 / 5)));
}

// No responsiveTime → squeeze is the classic uniform proportional rescale (backward compatible).
{
  const anims: TimelineKeyframeV2[] = [
    { id: "a", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 2.5, value: 100, interpolation: "linear", temporal: {} }
  ];
  const layer = {
    id: "L",
    trackId: "T",
    type: "text",
    name: "t",
    startSeconds: 3,
    durationSeconds: 5,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
    animations: anims
  } as unknown as TimelineLayer;
  const out = squeezeLayerKeyframesTo(layer, 3, 10);
  check("no-region: uniform factor (2.5×2=5.0)", near(out.animations![0]!.timeSeconds, 5.0));
}

// With responsiveTime: region-aware squeeze via the layer field (fade-in/mid/fade-out, 5→10).
{
  const anims: TimelineKeyframeV2[] = [
    { id: "in0", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 0, value: 0, interpolation: "linear", temporal: {} },
    { id: "in1", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 0.5, value: 100, interpolation: "linear", temporal: {} },
    { id: "mid", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 2.5, value: 100, interpolation: "linear", temporal: {} },
    { id: "out0", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 4.5, value: 100, interpolation: "linear", temporal: {} },
    { id: "out1", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 5.0, value: 0, interpolation: "linear", temporal: {} }
  ];
  const layer = {
    id: "L2",
    trackId: "T",
    type: "text",
    name: "t",
    startSeconds: 0,
    durationSeconds: 5,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
    animations: anims,
    responsiveTime: { introSeconds: 0.5, outroSeconds: 0.5 }
  } as unknown as TimelineLayer;
  const out = squeezeLayerKeyframesTo(layer, 0, 10);
  const at = (id: string) => out.animations!.find((a) => a.id === id)!.timeSeconds;
  check("region squeeze: fade-in end still 0.5", near(at("in1"), 0.5));
  check("region squeeze: fade-out start re-anchored to 9.5", near(at("out0"), 9.5));
  check("region squeeze: fade-out end at new end 10.0", near(at("out1"), 10.0));
  check("region squeeze: middle grew (2.5 → 5.0)", near(at("mid"), 5.0));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll responsive-time checks passed");
