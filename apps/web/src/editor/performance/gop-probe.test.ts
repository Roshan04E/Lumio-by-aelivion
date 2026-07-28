/**
 * Gate for the GOP-density decision that replaced "small file ⇒ cheap to decode" in the ingest-proxy
 * engine. The failure it guards is asymmetric, so both directions are asserted explicitly:
 *
 *  - Missing a sparse source (false negative) = the smoke-clip freeze: no proxy → `preferNativeDecode`
 *    → the `<video>` element path → a Flarex loader that freeze-plays.
 *  - Over-triggering (false positive) = the "+22 queued" build storm that starves playback, which is
 *    why an unreadable profile must answer "no" rather than "build it to be safe".
 */

import { summarizeGopGaps, needsProxyForDecodeCost, describeGopProfile, MAX_TOLERABLE_GOP_FRAMES } from "./gop-probe";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${label}`);
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  check(`${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected);
}

/** Sync flags for `count` frames with a keyframe every `every` frames. */
function cadence(count: number, every: number): boolean[] {
  return Array.from({ length: count }, (_, i) => i % every === 0);
}

// --- Unknowable inputs must not conclude anything -------------------------------------------------
eq("empty track → null", summarizeGopGaps([]), null);
eq(
  "no sync flags at all → null (absent stss means ALL samples are sync per ISO 14496-12 — the opposite of sparse)",
  summarizeGopGaps([false, false, false, false]),
  null
);
eq("null profile never triggers a build", needsProxyForDecodeCost(null), false);
eq("null profile describes itself honestly", describeGopProfile(null), "gop unknown");

// --- Dense sources: today's skip must survive -----------------------------------------------------
{
  const allKey = summarizeGopGaps(cadence(120, 1));
  check("intra-only track summarizes", allKey !== null);
  eq("intra-only max gap is 1", allKey!.maxGapFrames, 1);
  eq("intra-only keyframe count", allKey!.keyframeCount, 120);
  eq("intra-only does not need a proxy", needsProxyForDecodeCost(allKey), false);
}
{
  // The proxy recipe's own output: keyframe every 12 frames. Re-proxying our own proxies would be a
  // build loop, so this MUST read as dense.
  const recipe = summarizeGopGaps(cadence(600, 12));
  eq("proxy-recipe cadence (12f) does not need a proxy", needsProxyForDecodeCost(recipe), false);
  eq("proxy-recipe p95 gap is 12", recipe!.p95GapFrames, 12);
}
{
  const atBoundary = summarizeGopGaps(cadence(600, MAX_TOLERABLE_GOP_FRAMES));
  eq("exactly at the tolerance is NOT sparse (strict >)", needsProxyForDecodeCost(atBoundary), false);
  const overBoundary = summarizeGopGaps(cadence(600, MAX_TOLERABLE_GOP_FRAMES + 1));
  eq("one frame over the tolerance IS sparse", needsProxyForDecodeCost(overBoundary), true);
}

// --- Sparse sources: the smoke-clip case ----------------------------------------------------------
{
  // 45s @ 30fps with a keyframe every 5 seconds — a plausible smoke/fog overlay encode. Small file,
  // brutal seeks. This is the exact source that skipped as "source small enough" and then froze.
  const smoke = summarizeGopGaps(cadence(1350, 150));
  check("smoke-like track summarizes", smoke !== null);
  eq("smoke p95 gap", smoke!.p95GapFrames, 150);
  eq("smoke-like source needs a proxy despite being small", needsProxyForDecodeCost(smoke), true);
  check("description carries the numbers", describeGopProfile(smoke).includes("150"));
}

// --- p95, not max: one bad stretch must not conscript a healthy source ----------------------------
{
  // 600 dense frames (keyframe every 10) with a single 200-frame run bolted on the end.
  const flags = [...cadence(600, 10), ...Array.from({ length: 200 }, () => false)];
  const profile = summarizeGopGaps(flags);
  check("outlier max is large", profile!.maxGapFrames >= 200);
  check("outlier p95 stays small", profile!.p95GapFrames <= MAX_TOLERABLE_GOP_FRAMES);
  eq("a single outlier gap does not trigger a build", needsProxyForDecodeCost(profile), false);
}
{
  // Inverse: mostly sparse with a few dense keyframes must still trigger.
  const flags = [...cadence(60, 2), ...cadence(900, 90)];
  eq("predominantly sparse triggers even with a dense head", needsProxyForDecodeCost(summarizeGopGaps(flags)), true);
}

// --- Structural edges ------------------------------------------------------------------------------
{
  // Frames before the first keyframe are not decodable, so they are not a seek cost.
  const leading = summarizeGopGaps([false, false, false, true, false, true]);
  eq("undecodable leading frames are excluded from gaps", leading!.maxGapFrames, 2);
  eq("leading-garbage keyframe count", leading!.keyframeCount, 2);
}
{
  // The tail run IS a seek cost: landing on the last frame decodes forward from the last keyframe.
  const tail = summarizeGopGaps([true, ...Array.from({ length: 99 }, () => false)]);
  eq("tail run counts as a gap", tail!.maxGapFrames, 100);
  eq("single-keyframe long track needs a proxy", needsProxyForDecodeCost(tail), true);
}
{
  const single = summarizeGopGaps([true]);
  eq("one-frame track max gap", single!.maxGapFrames, 1);
  eq("one-frame track needs nothing", needsProxyForDecodeCost(single), false);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
