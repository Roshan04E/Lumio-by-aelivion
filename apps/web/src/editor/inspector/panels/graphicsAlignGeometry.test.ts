/**
 * Standalone assert script for the Graphics-tab align/distribute geometry (§3).
 * Repo convention: no test framework — exits non-zero on first failure.
 *
 *   pnpm --filter @kimera-by-aelivion/web graphics:align:test
 */
import { alignTargets, distributeTargets, unionBounds, type PaintedBox } from "./graphicsAlignGeometry";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

const near = (a: number | undefined, b: number, eps = 1e-6) => a !== undefined && Math.abs(a - b) < eps;

function box(id: string, cx: number, cy: number, w: number, h: number, locked = false): PaintedBox {
  return { id, cx, cy, w, h, locked };
}

// --- unionBounds ---------------------------------------------------------------
{
  const b = unionBounds([box("a", 30, 50, 20, 10), box("b", 70, 50, 20, 10)])!;
  check("unionBounds left", near(b.left, 20));
  check("unionBounds right", near(b.right, 80));
  check("unionBounds cx", near(b.cx, 50));
  check("unionBounds empty → null", unionBounds([]) === null);
}

// --- alignTargets: frame mode --------------------------------------------------
{
  const a = box("a", 50, 50, 20, 10);
  check("frame left", near(alignTargets([a], "left", "frame", null).get("a")?.x, 10));
  check("frame right", near(alignTargets([a], "right", "frame", null).get("a")?.x, 90));
  check("frame centerH", near(alignTargets([a], "centerH", "frame", null).get("a")?.x, 50));
  check("frame top", near(alignTargets([a], "top", "frame", null).get("a")?.y, 5));
  check("frame bottom", near(alignTargets([a], "bottom", "frame", null).get("a")?.y, 95));
  check("frame middle", near(alignTargets([a], "middle", "frame", null).get("a")?.y, 50));
}

// --- alignTargets: selection mode ---------------------------------------------
{
  const a = box("a", 30, 50, 20, 10);
  const b = box("b", 70, 50, 20, 10);
  const bounds = unionBounds([a, b]);
  const left = alignTargets([a, b], "left", "selection", bounds);
  check("selection left aligns both edges to bounds.left", near(left.get("a")?.x, 30) && near(left.get("b")?.x, 30));
  const right = alignTargets([a, b], "right", "selection", bounds);
  check("selection right aligns both edges to bounds.right", near(right.get("a")?.x, 70) && near(right.get("b")?.x, 70));
  const centerH = alignTargets([a, b], "centerH", "selection", bounds);
  check("selection centerH → bounds center", near(centerH.get("a")?.x, 50) && near(centerH.get("b")?.x, 50));
}

// --- alignTargets: locked layers never move -----------------------------------
{
  const a = box("a", 30, 50, 20, 10, true); // locked
  const b = box("b", 70, 50, 20, 10);
  const writes = alignTargets([a, b], "left", "frame", null);
  check("locked layer omitted from writes", !writes.has("a") && writes.has("b"));
}

// --- distributeTargets: centers -----------------------------------------------
{
  const boxes = [box("a", 0, 50, 10, 10), box("b", 30, 50, 10, 10), box("c", 100, 50, 10, 10)];
  const w = distributeTargets(boxes, "h", "centers");
  check("centers moves interior to midpoint", near(w.get("b")?.x, 50));
  check("centers leaves ends untouched", !w.has("a") && !w.has("c"));
}

// --- distributeTargets: gaps (accounts for box sizes) -------------------------
{
  const boxes = [box("a", 10, 50, 20, 10), box("b", 40, 50, 10, 10), box("c", 90, 50, 20, 10)];
  // span 0..100, total width 50, 2 gaps of 25 → B center at 45 + 5 = 50.
  const w = distributeTargets(boxes, "h", "gaps");
  check("gaps places interior by even edge spacing", near(w.get("b")?.x, 50));
  check("gaps leaves ends untouched", !w.has("a") && !w.has("c"));
}

// --- distributeTargets: needs 3+, respects locked interior --------------------
{
  check("distribute <3 → empty", distributeTargets([box("a", 0, 0, 10, 10), box("b", 50, 0, 10, 10)], "h", "centers").size === 0);
  const boxes = [box("a", 0, 50, 10, 10), box("b", 30, 50, 10, 10, true), box("c", 100, 50, 10, 10)];
  check("locked interior not moved", distributeTargets(boxes, "h", "centers").size === 0);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll graphics align/distribute geometry checks passed");
