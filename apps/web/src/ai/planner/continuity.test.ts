/**
 * Standalone assert script for the P10 intent-continuity classifier. Repo
 * convention: no test framework — exits non-zero on first failure.
 *
 *   pnpm --filter @lumio-by-aelivion/web continuity:test
 */
import { classifyContinuity } from "./intent-continuity";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

const withLast = { hasLastAction: true, hasSelection: false };
const fresh = { hasLastAction: false, hasSelection: false };
const selected = { hasLastAction: false, hasSelection: true };

// --- Continue: deltas / pronouns / connectives, only when there's a prior edit ---
check("'make it bigger' with last action → continue", classifyContinuity("make it bigger", withLast).scope === "continue");
check("'make it bigger' with no history → new", classifyContinuity("make it bigger", fresh).scope === "new");
check("'recolor it green' → continue", classifyContinuity("recolor it green", withLast).scope === "continue");
check("'now make it smaller' → continue", classifyContinuity("now make it smaller", withLast).scope === "continue");
check("'the same but blue' → continue", classifyContinuity("the same but blue", withLast).scope === "continue");

// --- New: a fresh object overrides recency ------------------------------------
check("'add a blue box' after an edit → new", classifyContinuity("add a blue box", withLast).scope === "new");
check("'add captions' → new (tool noun)", classifyContinuity("add captions", withLast).scope === "new");
check("'add text saying SALE' → new (content marker)", classifyContinuity('add text saying SALE', withLast).scope === "new");
check("'add a red circle' → new (shape kind)", classifyContinuity("add a red circle", withLast).scope === "new");

// --- Connective + new object: still new (don't suppress the new layer) ---------
check("'also add a fade in' → new object wins", classifyContinuity("also add a fade in", withLast).scope === "new");

// --- Selection forces continue when no new object is introduced ---------------
check("'center this' with selection → continue", classifyContinuity("center this", selected).scope === "continue");
check("'make it bold' with selection → continue", classifyContinuity("make it bold", selected).scope === "continue");
check("'add a circle' with selection → new (new object)", classifyContinuity("add a circle", selected).scope === "new");

// --- Safe default: ambiguous + prior edit → new -------------------------------
check("'cinematic vibes' with last action → new (no continuation signal)", classifyContinuity("cinematic vibes", withLast).scope === "new");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll intent-continuity checks passed");
