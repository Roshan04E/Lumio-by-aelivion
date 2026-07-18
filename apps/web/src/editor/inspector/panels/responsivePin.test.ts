/**
 * Standalone assert script for Responsive Pin (§1). Repo convention: no test framework — exits
 * non-zero on first failure.
 *
 *   pnpm --filter @orreris/web pin:test
 *
 * Covers the pure re-anchor math (reflowPinnedCenter) and the composition-level reflow driver
 * (reflowCompositionForResize) that bakes new positions on reframe.
 */
import { pinIsActive, reflowPinnedCenter, type TimelineComposition, type TimelineLayer } from "@orreris/shared";
import { reflowCompositionForResize } from "./graphicsReflow";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- pinIsActive -----------------------------------------------------------------------
{
  check("pinIsActive: undefined → false", !pinIsActive(undefined));
  check("pinIsActive: center/center → false", !pinIsActive({ x: "center", y: "center" }));
  check("pinIsActive: left → true", pinIsActive({ x: "left" }));
  check("pinIsActive: bottom → true", pinIsActive({ y: "bottom" }));
}

// --- reflowPinnedCenter: center is a no-op (backward compatible) ------------------------
{
  const out = reflowPinnedCenter({ x: "center", y: "center" }, { cx: 30, cy: 70, w: 20, h: 10 }, { w: 40, h: 20 });
  check("center: x unchanged", near(out.x, 30));
  check("center: y unchanged", near(out.y, 70));
}

// --- reflowPinnedCenter: left holds the LEFT edge percent -------------------------------
{
  // old box: center 30, width 20 → left edge 20. New width 40 → new center = 20 + 20 = 40.
  const out = reflowPinnedCenter({ x: "left" }, { cx: 30, cy: 50, w: 20, h: 10 }, { w: 40, h: 10 });
  check("left: left edge held (20) → center 40", near(out.x, 40));
  check("left: left edge percent preserved", near(out.x - 40 / 2, 30 - 20 / 2));
  check("left: y untouched when y unset (center)", near(out.y, 50));
}

// --- reflowPinnedCenter: right holds the RIGHT edge percent -----------------------------
{
  // old box: center 90, width 20 → right edge 100. New width 40 → new center = 100 - 20 = 80.
  const out = reflowPinnedCenter({ x: "right" }, { cx: 90, cy: 50, w: 20, h: 10 }, { w: 40, h: 10 });
  check("right: right edge held (100) → center 80", near(out.x, 80));
  check("right: right edge percent preserved", near(out.x + 40 / 2, 90 + 20 / 2));
}

// --- reflowPinnedCenter: top/bottom on Y ----------------------------------------------
{
  // bottom pin, old center 90 h 10 → bottom edge 95; new h 30 → new center = 95 - 15 = 80.
  const out = reflowPinnedCenter({ y: "bottom" }, { cx: 50, cy: 90, w: 20, h: 10 }, { w: 20, h: 30 });
  check("bottom: bottom edge held (95) → center 80", near(out.y, 80));
  check("bottom: x untouched when x unset", near(out.x, 50));
}

// --- reflowPinnedCenter: same size in/out → no shift (frame-relative box) ---------------
{
  const out = reflowPinnedCenter({ x: "right", y: "bottom" }, { cx: 90, cy: 90, w: 20, h: 20 }, { w: 20, h: 20 });
  check("stable size: right/bottom unchanged", near(out.x, 90) && near(out.y, 90));
}

// --- reflowCompositionForResize: bakes pinned layer, leaves unpinned + keyframed alone --
{
  const baseTransform = { position: { x: 90, y: 90 }, scale: 1, rotation: 0, opacity: 100 };
  function shape(over: Partial<TimelineLayer>): TimelineLayer {
    return {
      id: "s",
      trackId: "tr",
      type: "shape",
      name: "Box",
      startSeconds: 0,
      durationSeconds: 3,
      transform: JSON.parse(JSON.stringify(baseTransform)),
      effects: [],
      keyframes: [],
      widthPercent: 20,
      heightPercent: 20,
      ...over
    } as TimelineLayer;
  }
  // A shape's box is %-of-frame on BOTH axes, so its box percent is frame-invariant → a pin is a
  // natural no-op. Use an image with fixed natural aspect + fit:contain so the box DOES change.
  function logo(over: Partial<TimelineLayer>): TimelineLayer {
    return shape({
      id: "logo",
      type: "image",
      fit: "contain",
      graphic: undefined,
      widthPercent: undefined,
      heightPercent: undefined,
      ...over
    });
  }

  const comp = (w: number, h: number, layers: TimelineLayer[]): TimelineComposition =>
    ({ id: "c", name: "c", width: w, height: h, fps: 30, durationSeconds: 3, backgroundColor: "#000", tracks: [{ id: "tr", name: "V1", type: "video", layers }] } as unknown as TimelineComposition);

  // Unpinned shape: reflow is a strict no-op (identity returned).
  {
    const before = comp(1920, 1080, [shape({})]);
    const next = comp(1080, 1920, [shape({})]);
    const out = reflowCompositionForResize(next, { width: before.width, height: before.height }, 0);
    check("driver: unpinned layer → identity (===)", out === next);
  }

  // Right/bottom-pinned shape whose box % is frame-invariant → positions unchanged, identity returned.
  {
    const next = comp(1080, 1920, [shape({ responsive: { x: "right", y: "bottom" } })]);
    const out = reflowCompositionForResize(next, { width: 1920, height: 1080 }, 0);
    const layer = out.tracks[0]!.layers[0]!;
    check("driver: pinned frame-relative shape stays at 90/90", near(layer.transform.position.x, 90) && near(layer.transform.position.y, 90));
  }

  // Keyframed position is left untouched even when pinned (can't bake without flattening animation).
  {
    const kf = logo({
      responsive: { x: "left" },
      transform: { position: { x: 20, y: 50 }, scale: 0.5, rotation: 0, opacity: 100 },
      keyframes: [
        { id: "k1", target: { property: "transform.position.x" }, timeSeconds: 0, value: 20, interpolation: "linear" },
        { id: "k2", target: { property: "transform.position.x" }, timeSeconds: 1, value: 80, interpolation: "linear" }
      ] as TimelineLayer["keyframes"]
    });
    const next = comp(1080, 1920, [kf]);
    const out = reflowCompositionForResize(next, { width: 1920, height: 1080 }, 0);
    check("driver: keyframed X not baked (out === next identity)", out === next);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll responsive-pin checks passed");
