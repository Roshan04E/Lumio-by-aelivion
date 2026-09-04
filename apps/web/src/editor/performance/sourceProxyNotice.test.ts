/**
 * Gate for the proxy notice copy (DEBT-033). The defect being guarded is not a rendering bug — it is
 * a SENTENCE that was false: "Media optimization finished — proxies rebuilt at full quality" fired
 * over a run where 6 of 11 assets got no proxy, and "playback may be softer" described 1080p while
 * 4K was measured frozen. Both are pure string decisions, so they are asserted here in milliseconds
 * rather than by a browser gate; the browser instrument's job is the thing only it can see (that the
 * canvas state and the notice agree).
 */

import { describeProxyDrainOutcome, describeProxyPlaybackCost } from "./sourceProxyNotice";
import { proxyDimensionsFor } from "./sourceProxyDimensions";
import type { SourceProxyDrainSummary } from "./sourceProxyEngine";

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

function summary(partial: Partial<SourceProxyDrainSummary>): SourceProxyDrainSummary {
  return { total: 0, built: 0, failed: 0, skipped: 0, failures: [], ...partial };
}

// ---------------------------------------------------------------------------------------------
// (a) The completion notice must never claim a success it did not have.
// ---------------------------------------------------------------------------------------------

const allBuilt = describeProxyDrainOutcome(summary({ total: 4, built: 4 }));
check(`clean run states the count — "${allBuilt}"`, /all 4 optimized/.test(allBuilt));
check("clean run does not warn", !/failed/i.test(allBuilt));

// The measured 11x4K run: 5 built, 6 lost. The OLD copy said "proxies rebuilt at full quality".
const measured = describeProxyDrainOutcome(
  summary({ total: 11, built: 5, failed: 6, failures: [{ assetId: "a", note: "proxy persist failed: QuotaExceededError" }] })
);
check(`partial run reports both counts — "${measured}"`, /5 of 11 optimized/.test(measured) && /6 failed/.test(measured));
check("partial run never claims everything is optimized", !/all 11/.test(measured));
check("partial run states the consequence, not just the count", /originals/.test(measured) && /freeze/i.test(measured));

const skipped = describeProxyDrainOutcome(summary({ total: 3, built: 1, skipped: 2 }));
check(`skips are reported as skips — "${skipped}"`, /2 needed none/.test(skipped) && !/all 3/.test(skipped));

const noneBuilt = describeProxyDrainOutcome(summary({ total: 2, failed: 2 }));
check(`total failure is not phrased as success — "${noneBuilt}"`, /2 failed/.test(noneBuilt) && !/all /.test(noneBuilt));

const unknown = describeProxyDrainOutcome(null);
check(`an unrecorded batch says so — "${unknown}"`, /no outcome recorded/.test(unknown));

// ---------------------------------------------------------------------------------------------
// (b) + (d) The in-progress notice must be true at BOTH resolutions, and must say that waiting wins.
// ---------------------------------------------------------------------------------------------

const hd = describeProxyPlaybackCost(1080);
check(`1080p keeps the softer wording — "${hd}"`, /softer/.test(hd));
check("1080p does not claim a freeze", !/freeze/i.test(hd));

const uhd = describeProxyPlaybackCost(2160);
check(`4K says frozen, not softer — "${uhd}"`, /freeze/i.test(uhd) && !/softer/.test(uhd));
check("4K names the resolution tier", /4K/.test(uhd));

const qhd = describeProxyPlaybackCost(1440);
check(`1440p is on the honest branch — "${qhd}"`, /freeze/i.test(qhd));

const unprobed = describeProxyPlaybackCost(null);
check(`unknown resolution covers both tiers — "${unprobed}"`, /softer/.test(unprobed) && /frozen/i.test(unprobed));

// (d) THE TRAP. Playing suspends the builds that would end the freeze, so the user's instinct —
// press play again, scrub around — extends the exact window causing the problem. Every variant of
// this notice must say that waiting is the winning move; a notice that omits it is the trap.
for (const [label, text] of [
  ["1080p", hd],
  ["4K", uhd],
  ["1440p", qhd],
  ["unprobed", unprobed],
] as const) {
  check(`${label} tells the user playing pauses the build`, /Playing pauses optimizing/.test(text));
  check(`${label} tells the user parking is fastest`, /parked finishes soonest/.test(text));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// (e) THE WARM PATH'S UNIT, asserted rather than argued (2026-09-04).
//
// The un-proxied (COLD) decode budget is expressed in PIXELS, because a stream there is whatever the
// source happens to be — 4K carries ~4x the pixels of 1080p. The WARM path is budgeted in STREAM COUNT,
// and the justification is not a hypothesis about behaviour: PROXY_LONG_EDGE normalises every proxy to
// the same long edge, so sources of wildly different sizes encode to IDENTICAL dimensions and cost the
// decoder the same. That is arithmetic — and checking the arithmetic is cheaper AND stronger evidence
// than a browser arm run on media confounded in the direction of the answer.
const uhdProxy = proxyDimensionsFor(2160, 3840); // Pexels 4K vertical → scale 0.333
const hdProxy = proxyDimensionsFor(1080, 1920); // the matched 1080p set → scale 0.667
check(`4K source proxies to 720x1280 — got ${uhdProxy.width}x${uhdProxy.height}`, uhdProxy.width === 720 && uhdProxy.height === 1280);
check(`1080p source proxies to 720x1280 — got ${hdProxy.width}x${hdProxy.height}`, hdProxy.width === 720 && hdProxy.height === 1280);
check(
  "a 4K and a 1080p source produce IDENTICAL proxy dimensions (why the warm path may count streams)",
  uhdProxy.width === hdProxy.width && uhdProxy.height === hdProxy.height
);
// Landscape too, so the claim is about the LONG EDGE and not an artifact of two portrait fixtures.
const uhdLand = proxyDimensionsFor(3840, 2160);
check(`landscape 4K proxies to 1280x720 — got ${uhdLand.width}x${uhdLand.height}`, uhdLand.width === 1280 && uhdLand.height === 720);
// Never upscale: a source already below the long edge keeps its own size.
const small = proxyDimensionsFor(640, 360);
check(`a sub-proxy-sized source is not upscaled — got ${small.width}x${small.height}`, small.width === 640 && small.height === 360);
// H.264 chroma needs even dimensions, so odd input must round rather than truncate to odd.
const odd = proxyDimensionsFor(1921, 1081);
check(`odd dimensions round to even — got ${odd.width}x${odd.height}`, odd.width % 2 === 0 && odd.height % 2 === 0);

console.log(`\nsource-proxy notice: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
