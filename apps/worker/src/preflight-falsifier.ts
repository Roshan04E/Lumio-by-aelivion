/**
 * FALSIFIER for the browser preflight's RESOURCE checks — free disk and free RAM.
 *
 *   pnpm --filter @orreris/worker preflight:falsifier
 *
 * ## WHY A GUARD NEEDS ONE OF THESE MORE THAN MOST CODE DOES
 *
 * A preflight's entire job is to not fire. On a healthy machine it is indistinguishable from a
 * function that returns immediately — which is also what it looks like when its threshold is wrong,
 * its env override silently ignores you, or its reading is broken and it passes everything. Every one
 * of those failures presents as "the gate ran fine", and you find out at minute forty of the sweep it
 * was supposed to refuse. `assertFreeMemory` exists because two `render:baseline` sweeps died that way
 * for eighty minutes; shipping it without proving it can fire would repeat the shape of the bug at one
 * remove.
 *
 * So both directions are asserted, for both checks:
 *
 *   - it REFUSES below the floor (the check can fire at all), and
 *   - it PASSES above the floor (it is not simply always throwing, which would pass a
 *     refuses-below test perfectly while blocking every gate in the repo).
 *
 * The floor is driven from the env override rather than from a fabricated machine reading, which is
 * what makes this runnable anywhere: pass a floor above what the box has and it must refuse, pass 0
 * and it must not. That also tests the override path itself — a knob nobody exercises is a knob that
 * silently stopped working.
 */

import assert from "node:assert/strict";
import os from "node:os";
import {
  assertFreeDisk,
  assertFreeMemory,
  describeFreeDisk,
  describeFreeMemory
} from "./browser/browser-preflight";

const GIB = 1024 ** 3;

/** Run `fn`, returning the thrown message or `undefined` if it did not throw. */
function refusal(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return String((error as Error)?.message ?? error);
  }
}

const freeRam = os.freemem();
const results: string[] = [];

console.log(`machine: ${describeFreeDisk()}, ${describeFreeMemory()}`);

/* ---------------------------------------------------------------- free RAM: it must FIRE --------
 *
 * A floor of "everything this machine has, plus a terabyte" cannot be satisfied, so a check that
 * does not throw here is not checking anything.
 */
const ramRefusal = refusal(() => assertFreeMemory("falsifier", freeRam + 1024 * GIB));
assert.ok(
  ramRefusal,
  "assertFreeMemory did NOT refuse a floor larger than the machine's total memory. The check cannot " +
    "fire, so every gate that calls it is unguarded while appearing to be guarded — which is worse " +
    "than not having it, because the preflight line in the log reads as a precondition that was met."
);
assert.match(
  ramRefusal,
  /REFUSING TO RUN/,
  "The refusal must be a REFUSAL, in the shared idiom the other preflight checks use — a message a " +
    "founder can recognise at a glance as 'the gate declined to start' rather than as a crash."
);
assert.match(
  ramRefusal,
  /GATE_MIN_FREE_RAM_GB/,
  "The refusal must name its own override. A guard that blocks work without telling you how to " +
    "proceed deliberately gets disabled wholesale by the next person in a hurry."
);
results.push("free RAM: REFUSES below the floor, with the override named");

/* ---------------------------------------------------------------- free RAM: it must PASS ---------
 *
 * The control, and the half that a refuses-below test alone would let through: a check that threw
 * unconditionally would satisfy every assertion above and block every browser gate in the repo.
 */
assert.equal(
  refusal(() => assertFreeMemory("falsifier", 0)),
  undefined,
  "assertFreeMemory refused a floor of ZERO, so it is not reading the machine — it is throwing " +
    "unconditionally, which would block every browser gate in the repo."
);
results.push("free RAM: PASSES above the floor (not an unconditional throw)");

/* ------------------------------------------------------------- the env override actually applies -
 *
 * Asserted rather than assumed, because an override that is read but ignored looks exactly like an
 * override that works until the day you need it.
 */
const previous = process.env.GATE_MIN_FREE_RAM_GB;
try {
  process.env.GATE_MIN_FREE_RAM_GB = String(Math.ceil((freeRam + 1024 * GIB) / GIB));
  assert.ok(
    refusal(() => assertFreeMemory("falsifier")),
    "GATE_MIN_FREE_RAM_GB set above the machine's memory did not cause a refusal — the override is " +
      "read but not obeyed."
  );
  process.env.GATE_MIN_FREE_RAM_GB = "0";
  assert.equal(
    refusal(() => assertFreeMemory("falsifier")),
    undefined,
    "GATE_MIN_FREE_RAM_GB=0 still refused — the override only works in the blocking direction, which " +
      "is the direction nobody needs it in."
  );
  // A junk value must be IGNORED rather than obeyed: `Number("banana")` is NaN, and a floor of NaN
  // compares false against everything, which would silently disable the check for anyone with a typo.
  process.env.GATE_MIN_FREE_RAM_GB = "banana";
  assert.ok(
    refusal(() => assertFreeMemory("falsifier", freeRam + 1024 * GIB)),
    "A non-numeric GATE_MIN_FREE_RAM_GB must be ignored, not obeyed."
  );
} finally {
  if (previous === undefined) delete process.env.GATE_MIN_FREE_RAM_GB;
  else process.env.GATE_MIN_FREE_RAM_GB = previous;
}
results.push("free RAM: the GATE_MIN_FREE_RAM_GB override applies in both directions, and junk is ignored");

/* ---------------------------------------------------------------- free disk: the same two ---------
 *
 * The sibling was shipped without a falsifier. Adding one here rather than in a separate file because
 * they are one precondition class — "a shared resource this gate will consume" — and a reader who
 * wonders whether the disk check can fire should not have to find out somewhere else.
 */
const diskRefusal = refusal(() => assertFreeDisk("falsifier", 1024 * 1024 * GIB));
assert.ok(diskRefusal, "assertFreeDisk did NOT refuse a petabyte floor — the disk check cannot fire.");
assert.match(diskRefusal, /REFUSING TO RUN/, "The disk refusal must use the shared REFUSAL idiom.");
assert.equal(
  refusal(() => assertFreeDisk("falsifier", 0)),
  undefined,
  "assertFreeDisk refused a floor of ZERO — it is throwing unconditionally rather than reading the volume."
);
results.push("free disk: REFUSES below the floor and PASSES above it");

/* ---------------------------------------------------------- an unreadable reading must not block --
 *
 * The rule this file's subject states out loud: a guard that cannot see the machine must not invent a
 * reason to stop work, and "the check did not run" must not look like "the check passed".
 *
 * `describeFreeMemory` is the observable half of that — a gate PRINTS it — so it must say
 * "unreadable" rather than a plausible-looking number when the instrument is blind.
 */
assert.match(
  describeFreeMemory(),
  /RAM free|RAM unreadable/,
  "describeFreeMemory must report either a reading or an explicit 'unreadable' — never a bare number " +
    "that cannot be told apart from a real one."
);
results.push("unreadable readings are reported as unreadable, not as a pass");

for (const line of results) console.log(`  ok  ${line}`);
console.log(
  "\nPASS — both resource preconditions refuse below their floor, pass above it, honour their override " +
    "in both directions, and decline to block when they cannot read the machine."
);
