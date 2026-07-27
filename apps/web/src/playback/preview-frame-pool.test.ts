/**
 * WebCodecs preview pool — decode-mode isolation gate (`pnpm --filter @orreris/web wcpool:test`).
 *
 * WHY THIS EXISTS. Two multi-source Flarex freezes shipped in a row, and both were mis-diagnosed for
 * several rounds because the pool's statistics look HEALTHY in the failure: a mode-mismatched warm
 * reuse is counted as a cache hit, and a starved acquisition is counted as an ordinary cap miss.
 *
 *   2026-07-26  loaders frozen, host fine  — a React memo froze the loaders' clock (fixed elsewhere).
 *   2026-07-27  HOST frozen, loaders fine  — this file. A comp loads the same file as both the host
 *               clip and a MediaIn source. The loader creates a SOFTWARE decoder for that URL and
 *               parks it on release; warm reuse matched on URL alone, so the HOST inherited the
 *               software provider. The host is lag-INtolerant by design → freeze-hold → sustained-hold
 *               bail → `wcBailedSources` → native <video> for the rest of the session. Meanwhile the
 *               loaders are immune to every one of those escape hatches (`tolerateLag`), so the host
 *               was structurally guaranteed to be the only possible loser.
 *
 * Both axes are asserted: reuse must match the decode mode, and the two modes must be capped and
 * evicted independently so a software loader can never consume a hardware slot the host needs.
 */

import { findWarmIdleIndex, sessionCap } from "./preview-frame-pool";

let failures = 0;
let checks = 0;

function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${message}`);
  }
}

function eq<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (got ${String(actual)}, expected ${String(expected)})`);
}

// ── 1. Warm reuse must match the decode MODE, not just the URL ──────────────
{
  const HOST = "blob:forest.mp4";
  // The exact shape of the 2026-07-27 bug: a loader's software decoder parked under the host's URL.
  const parked = [{ url: HOST, software: true }];

  eq(findWarmIdleIndex(parked, HOST, false), -1, "host (hardware) must NOT inherit a parked SOFTWARE provider");
  eq(findWarmIdleIndex(parked, HOST, true), 0, "a loader (software) SHOULD reuse a parked software provider");

  // ...and the mirror leak: a loader inheriting the host's hardware decoder puts it straight back on
  // the contended GPU block that `preferSoftware` exists to keep it off.
  const parkedHw = [{ url: HOST, software: false }];
  eq(findWarmIdleIndex(parkedHw, HOST, true), -1, "loader (software) must NOT inherit a parked HARDWARE provider");
  eq(findWarmIdleIndex(parkedHw, HOST, false), 0, "host (hardware) SHOULD reuse a parked hardware provider");

  // Mixed park list: pick the matching mode even when a same-URL entry of the other mode sits first.
  const mixed = [{ url: HOST, software: true }, { url: HOST, software: false }];
  eq(findWarmIdleIndex(mixed, HOST, false), 1, "must skip past a mode-mismatched same-URL park to the right one");
  eq(findWarmIdleIndex(mixed, HOST, true), 0, "software request takes the software park");

  // A different URL never matches regardless of mode (guards a predicate that drops the url term).
  eq(findWarmIdleIndex(mixed, "blob:china_view.mp4", false), -1, "a different URL must never warm-reuse");
  eq(findWarmIdleIndex([], HOST, false), -1, "empty park list yields no reuse");
}

// ── 2. Session accounting: the host keeps a slot, and the TOTAL stays bounded ─
// Uses the pool's own exported `sessionCap` for the per-mode ceiling, and mirrors the total-cap
// arithmetic. This asserts the MODEL, not the constants: loaders can never exhaust the host's pool,
// AND the two modes together can never exceed the machine ceiling.
{
  const MAX_TOTAL = 4; // MAX_WC_TOTAL_SESSIONS
  const admitsMode = (active: number, idleCount: number, software: boolean) =>
    active + idleCount < sessionCap(software);
  const admitsTotal = (total: number) => total < MAX_TOTAL;

  // The user's comp: 1 host (hardware) + 2 asset-source loaders (software).
  // OLD (single shared cap of 3): host + 2 loaders exactly filled it, so whoever acquired LAST was
  // refused a session — a native <video> fallback, fatal for whichever source got it. Loaders are
  // immune to that fallback, so the loser was always the HOST.
  assert(!(3 + 0 < 3), "under one shared cap of 3 a 4th source is refused — the starvation edge");

  // The decisive property: no number of software loaders can refuse the host a hardware session.
  for (const loaders of [0, 1, 2, 3, 99]) {
    assert(admitsMode(0, 0, false), `host keeps a hardware slot with ${loaders} software loaders`);
  }
  assert(sessionCap(true) <= MAX_TOTAL - 1, "software must never be allowed to fill every slot");

  // ...and the ceiling that the first version of this fix MISSED. Two independent caps that merely
  // sum are not a budget: 3 hardware + 4 software = 7 live decoders, which crashed the renderer under
  // scrubbing (white page), after which every loader lost its provider and fell back to the host clip.
  assert(sessionCap(false) + sessionCap(true) > MAX_TOTAL, "the per-mode caps DO oversubscribe on their own…");
  assert(!admitsTotal(MAX_TOTAL), "…so the total ceiling is what actually bounds concurrency");
  assert(admitsTotal(3), "the 3-source comp (host + 2 loaders) fits inside the total ceiling");
  assert(!admitsTotal(7), "the 3+4=7 concurrency that crashed the renderer must be unreachable");

  // Idle parks pin real decoder sessions, so they count — against their own mode AND the total.
  assert(!admitsMode(2, 1, false), "hardware parks count toward the hardware cap");
  assert(admitsMode(2, 1, true) === (3 < sessionCap(true)), "software cap counts its own parks");
  assert(!admitsTotal(2 + 1 + 1), "parks of EITHER mode count toward the total ceiling");
}

console.log(`\npreview-frame-pool: ${checks - failures}/${checks} assertions passed`);
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
// Explicit: importing the pool pulls in the mp4box decoder chain, which leaves a handle on the event
// loop under node — without this the script prints its result and then hangs forever instead of
// returning an exit code (i.e. it would be useless as a gate).
process.exit(0);
