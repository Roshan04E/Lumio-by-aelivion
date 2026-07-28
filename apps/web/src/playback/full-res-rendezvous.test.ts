/**
 * Gate for the ATOMIC FULL-RES SWAP rendezvous.
 *
 * Per `plans/flarex-evaluation-engine.md`: "a reuse mechanism must assert that it actually reuses" —
 * a barrier that never engages is trivially clean and worthless. So this asserts BOTH that sources
 * sharpen together AND that the decision actually flips, plus the two ways it must give up.
 *
 * Run: pnpm --filter @orreris/web fullres:test
 */

import { decideFullResRendezvous, FULL_RES_RENDEZVOUS_MAX_MS } from "./full-res-rendezvous";

let checks = 0;
let failures = 0;
function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${message}`);
  }
}

// ── 1. The core invariant: nobody sharpens until everybody can ───────────────────────────────────
{
  // Two of three sources have landed; the third is still seeking. Nothing swaps.
  const waiting = decideFullResRendezvous({ pendingCount: 1, readyCount: 2, pendingSinceMs: 1000, nowMs: 1200 });
  assert(!waiting.commit, "one source still pending → no swap, however many others are ready");

  // The last one lands. Now everything swaps, in ONE decision.
  const all = decideFullResRendezvous({ pendingCount: 0, readyCount: 3, pendingSinceMs: 1000, nowMs: 1300 });
  assert(all.commit && !all.viaHatch, "last source arrives → commit, and not via the hatch");
  assert(all.pendingSinceMs === null, "pending clock clears when nobody is pending");
}

// ── 2. It actually ENGAGES (the mechanism is not a no-op) ────────────────────────────────────────
{
  // Walk a realistic 3-source settle: staggered arrivals, then all ready.
  let pendingSince: number | null = null;
  let committed = false;
  let flips = 0;
  const arrivals = [3, 3, 2, 1, 0]; // pending count per frame as seeks land
  arrivals.forEach((pendingCount, i) => {
    const d = decideFullResRendezvous({
      pendingCount,
      readyCount: 3 - pendingCount,
      pendingSinceMs: pendingSince,
      nowMs: 1000 + i * 100,
    });
    pendingSince = d.pendingSinceMs;
    if (d.commit !== committed) flips += 1;
    committed = d.commit;
  });
  assert(committed, "after every source lands the viewer is committed");
  assert(flips === 1, `the swap happens exactly once, not once per source (got ${flips} flips)`);
}

// ── 3. Escape hatch: one source that can never seek must not hold the viewer soft forever ────────
{
  const justUnder = decideFullResRendezvous({
    pendingCount: 1,
    readyCount: 2,
    pendingSinceMs: 0,
    nowMs: FULL_RES_RENDEZVOUS_MAX_MS - 1,
  });
  assert(!justUnder.commit, "inside the budget the viewer keeps waiting");

  const atBudget = decideFullResRendezvous({
    pendingCount: 1,
    readyCount: 2,
    pendingSinceMs: 0,
    nowMs: FULL_RES_RENDEZVOUS_MAX_MS,
  });
  assert(atBudget.commit && atBudget.viaHatch, "at the budget the hatch fires and the ready sources sharpen");

  // A source that is pending with NOTHING ready has nothing to swap to — never commit.
  const nothingReady = decideFullResRendezvous({ pendingCount: 2, readyCount: 0, pendingSinceMs: 0, nowMs: 99999 });
  assert(!nothingReady.commit, "no upgrades available → never commit, whatever the wait");
}

// ── 4. Withdrawal is as atomic as the swap (the regression a one-way latch would cause) ──────────
{
  // Committed, then the user scrubs: every settle frame is invalidated at once and all sources go
  // pending. If this latched, stale full-res pixels from the OLD playhead would stay on screen.
  const afterScrub = decideFullResRendezvous({ pendingCount: 3, readyCount: 0, pendingSinceMs: null, nowMs: 5000 });
  assert(!afterScrub.commit, "transport movement withdraws the commit for ALL sources together");
  assert(afterScrub.pendingSinceMs === 5000, "a fresh pending episode starts its own clock");

  // ...and the new episode gets a FULL budget, rather than inheriting the old one and hatching instantly.
  const soonAfter = decideFullResRendezvous({ pendingCount: 3, readyCount: 1, pendingSinceMs: 5000, nowMs: 5100 });
  assert(!soonAfter.commit, "a new pending episode does not inherit the previous episode's elapsed budget");
}

// ── 5. Viewers with no upgrades at all never engage ──────────────────────────────────────────────
{
  // Stills, generators, clips whose proxy IS the original: nobody pending, nobody ready.
  const inert = decideFullResRendezvous({ pendingCount: 0, readyCount: 0, pendingSinceMs: null, nowMs: 1 });
  assert(!inert.commit, "a viewer with no full-res upgrades never commits");
  assert(!inert.viaHatch, "...and never reports a hatch");
}

// ── 6. Repeated frames while waiting must not drift the clock ────────────────────────────────────
{
  let pendingSince: number | null = 2000;
  for (let t = 2000; t < 2000 + FULL_RES_RENDEZVOUS_MAX_MS; t += 16) {
    const d = decideFullResRendezvous({ pendingCount: 1, readyCount: 1, pendingSinceMs: pendingSince, nowMs: t });
    pendingSince = d.pendingSinceMs;
    assert(!d.commit, `still waiting at t=${t}`);
  }
  assert(pendingSince === 2000, "the pending clock is anchored to the episode start, not re-stamped each frame");
  const hatched = decideFullResRendezvous({
    pendingCount: 1,
    readyCount: 1,
    pendingSinceMs: pendingSince,
    nowMs: 2000 + FULL_RES_RENDEZVOUS_MAX_MS,
  });
  assert(hatched.commit && hatched.viaHatch, "the budget is reached on schedule, so the hatch is reachable");
}

console.log(`\nfull-res-rendezvous: ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
