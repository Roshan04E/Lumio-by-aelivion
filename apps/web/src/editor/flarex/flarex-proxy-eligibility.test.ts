/**
 * Gate for the comp-proxy substitution rule (plans/flarex-comp-proxy.md, S2).
 *
 * The rule decides when an OPAQUE rendered proxy may replace a live node graph. Getting it wrong in
 * the permissive direction paints the composition background over every layer beneath the clip, and
 * that is invisible in any single-clip test — so the cases below are mostly about what must be
 * REFUSED. Run: pnpm --filter @orreris/web flarexproxy:test
 */

import type { TimelineLayer } from "@orreris/shared";
import { canSubstituteFlarexProxy } from "./flarex-proxy-eligibility";

let failures = 0;
function check(label: string, actual: boolean, expected: boolean): void {
  if (actual === expected) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label} — expected ${expected}, got ${actual}`);
  }
}

function layer(id: string, startSeconds: number, durationSeconds: number, type: TimelineLayer["type"] = "video"): TimelineLayer {
  return {
    id,
    trackId: "t",
    type,
    name: id,
    startSeconds,
    durationSeconds,
    fit: "fill",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
  } as TimelineLayer;
}

const host = layer("host", 2, 4); // occupies [2, 6)

// The safe case the rule exists to admit: nothing below the host at all.
check("bottom-most, alone", canSubstituteFlarexProxy([host], host), true);

// Layers ABOVE the host composite after it, so they are unaffected by a baked background.
check("layers above only", canSubstituteFlarexProxy([host, layer("above", 0, 10)], host), true);

// Audio has no picture — it can never be occluded.
check("audio below", canSubstituteFlarexProxy([layer("music", 0, 10, "audio"), host], host), true);

// A visual layer below that shares ANY instant of the span would be painted over.
check("below, fully overlapping", canSubstituteFlarexProxy([layer("bg", 0, 10), host], host), false);
check("below, overlaps head", canSubstituteFlarexProxy([layer("bg", 0, 3), host], host), false);
check("below, overlaps tail", canSubstituteFlarexProxy([layer("bg", 5, 5), host], host), false);
check("below, contained inside span", canSubstituteFlarexProxy([layer("bg", 3, 1), host], host), false);

// Disjoint in time: nothing is behind the host WHILE it is on screen, so opaque is still correct.
check("below, ends exactly at host start", canSubstituteFlarexProxy([layer("bg", 0, 2), host], host), true);
check("below, starts exactly at host end", canSubstituteFlarexProxy([layer("bg", 6, 2), host], host), true);
check("below, entirely earlier", canSubstituteFlarexProxy([layer("bg", 0, 1), host], host), true);

// Only the FIRST overlapping layer below needs to disqualify it, but a mix must not fool the scan.
check(
  "mixed: non-overlapping below, overlapping below, above",
  canSubstituteFlarexProxy([layer("early", 0, 1), layer("bg", 1, 4), host, layer("above", 0, 10)], host),
  false
);

// Unknown z-position must fail closed (→ live evaluation), never open.
check("host absent from the list", canSubstituteFlarexProxy([layer("other", 0, 10)], host), false);
check("empty list", canSubstituteFlarexProxy([], host), false);

// DEGENERATE: a zero-length layer below occupies no instant, so it could in principle be admitted.
// The rule refuses it — the half-open overlap test treats an empty interval as overlapping. That is
// the fail-CLOSED direction and it is the one we want: refusing costs a missed optimization, while
// admitting wrongly paints the background over everything below. Asserted so the behavior is
// deliberate rather than incidental, and so "fixing" the arithmetic can't silently open it up.
check("below, zero duration → refused (fail closed)", canSubstituteFlarexProxy([layer("bg", 3, 0), host], host), false);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nflarex-proxy-eligibility: all checks passed");
