/**
 * ADR-023 S9 (OQ6) — the per-character animation MODEL, asserted without a browser.
 *
 *   pnpm --filter @orreris/shared cluster:model
 *
 * WHY THIS IS SEPARATE FROM THE PIXEL GATE, AND WHY IT IS FIRST. The text programme has added roughly
 * twenty glyph-edge fixtures to a zero-tolerance picture gate, and glyph edges are where subpixel AA
 * is least stable — the last sweep found two fixtures oscillating in the low single digits of pixels
 * against an unchanged tree. A picture gate cannot tell a one-pixel gap between two bands from that
 * floor. Arithmetic can: a gap or an overlap in the tiling is exactly representable and exactly
 * assertable, in milliseconds, which is the CLAUDE.md rule about pushing the load-bearing check down
 * to the cheapest instrument that can tell the answers apart.
 *
 * What this file CANNOT do is prove that a tiled set of bands reassembles a real raster byte for byte.
 * That needs pixels, and it is `text:s9-slice-tiling`'s job.
 */

import assert from "node:assert/strict";
import {
  clusterPhase,
  hasTextClusterAnimationSource,
  isTextClusterAnimationAtRest,
  parseTextClusterAnimation,
  resolveTextClusterAnimation,
  segmentGraphemes,
  textClusterAnimationCss,
  textClusterAnimationOverhangEm,
  textClusterAnimationRefusal,
  tileSpans
} from "./text-cluster-animation";

const ARABIC = "مرحبا بالعالم";
const DEVANAGARI = "हिन्दी भाषा";

// ---------------------------------------------------------------- 1. a character is a CLUSTER
//
// The instrument's own falsifier first: on plain ASCII the clustering must AGREE with a code-point
// split, or the segmenter is doing something other than what this file thinks it is and every
// assertion below is about the wrong thing.
const plain = segmentGraphemes("abc");
assert.ok(plain, "Intl.Segmenter is unavailable in this runtime — the model cannot be asserted here.");
assert.equal(plain.length, 3, "VOID: the segmenter disagrees with a code-point split on plain ASCII.");

for (const [label, text] of [
  ["combining marks", "é̀"],
  ["emoji ZWJ", "\u{1F468}‍\u{1F469}‍\u{1F467}"]
] as const) {
  const clusters = segmentGraphemes(text)!;
  assert.equal(clusters.length, 1, `${label}: must be ONE cluster, not ${clusters.length}.`);
  assert.ok([...text].length > 1, `${label}: the case is void — a code-point split would agree.`);
}

// ---------------------------------------------------------------- 2. declaration vs rest vs absence
assert.equal(hasTextClusterAnimationSource({}), false, "absent stays absent (D1a).");
assert.equal(resolveTextClusterAnimation({}), undefined, "no field declared → no animation at all.");
// The distinction the whole D1a posture rests on: a layer that named only the RISE has an animation,
// and it is sitting at rest. That is not the same state as a layer that named nothing.
const restingByDefault = resolveTextClusterAnimation({ clusterRiseEm: 0.8 })!;
assert.equal(restingByDefault.progress, 1, "an undeclared progress resolves to 1 — finished, not zero.");
assert.equal(isTextClusterAnimationAtRest(restingByDefault), true);
assert.equal(
  textClusterAnimationOverhangEm(restingByDefault),
  0,
  "a settled animation must ask for NO extra raster margin, or a settled layer rasterizes into a " +
    "differently-sized canvas than an unanimated one and P4 fails on padding."
);
assert.equal(
  textClusterAnimationOverhangEm({ progress: 0.4, riseEm: 0.8, staggerFraction: 0.6 }),
  0.8,
  "mid-flight the raster must budget the full rise, or the motion is clipped by the box it moves in."
);

// ---------------------------------------------------------------- 3. the phase distribution
const anim = { progress: 0.45, riseEm: 0.8, staggerFraction: 0.6 };
const first = clusterPhase(0, 6, anim);
const last = clusterPhase(5, 6, anim);
assert.ok(first.eased > last.eased, "with a stagger the FIRST cluster must be further along than the last.");
// The first cluster has already ARRIVED at 45% of a 0.6-stagger reveal (its window is 0…0.4), which
// is the cascade working; the LAST one has not started. Asserting the first is displaced would have
// been asserting the stagger away.
assert.equal(first.offsetEm, 0, "the leading cluster has finished its own window by 45%.");
assert.ok(last.eased < 1 && last.offsetEm > 0, "mid-flight, something must actually be displaced.");
// The equality that matters more than any of the above: everything lands, exactly, and lands together.
for (const index of [0, 3, 5]) {
  const settled = clusterPhase(index, 6, { ...anim, progress: 1 });
  assert.equal(settled.offsetEm, 0, `cluster ${index} must be at zero offset at progress 1.`);
  assert.equal(settled.alpha, 1, `cluster ${index} must be fully opaque at progress 1.`);
}
// A stagger of exactly 1 is the degenerate input this model has to survive rather than divide by.
const extreme = clusterPhase(2, 6, { progress: 0.5, riseEm: 1, staggerFraction: 1 });
assert.ok(Number.isFinite(extreme.offsetEm) && Number.isFinite(extreme.alpha), "stagger 1 must not divide by zero.");
// A single cluster has no one to stagger against and must simply follow progress.
assert.equal(clusterPhase(0, 1, { progress: 0, riseEm: 1, staggerFraction: 0.9 }).alpha, 0);
assert.equal(clusterPhase(0, 1, { progress: 1, riseEm: 1, staggerFraction: 0.9 }).alpha, 1);

// ---------------------------------------------------------------- 4. THE TILING
//
// The acceptance bar for the slicing itself, before any animation is applied: the spans cover
// [lo, hi] with no gap and no overlap. A gap drops a column of pixels; an overlap composites one
// twice, which on an antialiased glyph edge is a visibly darker seam. Both are silent in a picture.
function assertTiles(starts: number[], lo: number, hi: number, label: string): void {
  const spans = tileSpans(starts, lo, hi);
  assert.equal(spans.length, starts.length, `${label}: one span per cluster.`);
  assert.equal(spans[0]!.x0, lo, `${label}: the first span must start at the canvas edge, not at the ink.`);
  assert.equal(spans[spans.length - 1]!.x1, hi, `${label}: the last span must end at the canvas edge.`);
  for (let i = 1; i < spans.length; i += 1) {
    assert.equal(
      spans[i]!.x0,
      spans[i - 1]!.x1,
      `${label}: span ${i} must begin exactly where span ${i - 1} ends — a gap or an overlap here is a ` +
        `dropped or double-composited column of pixels, and neither shows up as an error.`
    );
  }
  const covered = spans.reduce((sum, span) => sum + (span.x1 - span.x0), 0);
  assert.equal(covered, hi - lo, `${label}: the spans must cover the canvas exactly once.`);
}
assertTiles([10, 40, 70, 100], 0, 200, "even");
assertTiles([0, 1, 2], 0, 3, "tight");
assertTiles([50], 0, 200, "single cluster");
// Ink reaching outside its own advance — the reason the ends extend to the canvas rather than to the
// run. A band set that started at the first glyph's origin would drop its left side bearing.
assertTiles([80, 120], 0, 400, "narrow run on a wide canvas");
// The pathological input: prefix widths that go BACKWARDS. This is the ARABIC failure mode, and the
// point of asserting it is not that the answer is good — it is that the answer is still a TILING, so
// the failure is a wrong-looking animation and never a corrupted picture. The script is refused
// upstream regardless; this is the belt to that braces.
assertTiles([100, 60, 130], 0, 300, "non-monotonic starts");

// ---------------------------------------------------------------- 5. the refusals (T-14)
assert.equal(textClusterAnimationRefusal("HELLO", { pathCurveActive: false }), undefined, "Latin animates.");
assert.equal(
  textClusterAnimationRefusal(ARABIC, { pathCurveActive: false }),
  "script",
  "P3 — Arabic must be REFUSED. The spike measured 2 of 13 prefix widths going backwards, so the " +
    "bands are wrong before a pixel is drawn."
);
assert.equal(
  textClusterAnimationRefusal(DEVANAGARI, { pathCurveActive: false }),
  "script",
  "Devanagari must be refused too. The spike's Devanagari SAMPLE happened to slice exactly, and that " +
    "is a fact about the sample, not about the script — `detectTextScript` is the instrument, not one " +
    "measured string."
);
assert.equal(
  textClusterAnimationRefusal("HELLO", { pathCurveActive: true }),
  "curve",
  "P2 — a curved run has no cluster bands to slice."
);
// The refusal that has to be checkable, not assumed: an emoji ZWJ sequence is a shaping case, so it
// is refused as a script rather than animated per person.
assert.equal(textClusterAnimationRefusal("hi \u{1F468}‍\u{1F469}‍\u{1F467}", { pathCurveActive: false }), "script");

// ---------------------------------------------------------------- 6. the emitted round trip
assert.equal(textClusterAnimationCss(undefined), undefined, "no animation emits NO key (D1a).");
const round = parseTextClusterAnimation(textClusterAnimationCss({ progress: 0.45, riseEm: 0.8, staggerFraction: 0.6 })!);
assert.deepEqual(round, { progress: 0.45, riseEm: 0.8, staggerFraction: 0.6 }, "the emitted string must round-trip.");
assert.equal(parseTextClusterAnimation("0.5 0.8"), undefined, "a short string is a refusal, not a partial read.");
assert.equal(parseTextClusterAnimation("a b c"), undefined, "a non-numeric string is a refusal.");

console.log("PASS — clusters are grapheme clusters, absence is not rest, rest contributes nothing, the bands tile exactly, and the two shaping refusals hold.");
