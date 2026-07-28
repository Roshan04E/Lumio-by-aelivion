/**
 * Temporal-coherence gate (`pnpm --filter @orreris/web coherence:test`).
 *
 * WHY THIS EXISTS. A Flarex comp with three MediaIn loaders visibly filled in one source at a time on
 * a low-end machine — the presented composite mixed source A at t with source B at t−0.2, which is
 * not a real frame of the composition. The preview already batched presentation (one rAF loop, one
 * build, one render, one present); what it lacked was any notion of WHICH TIME each source's texture
 * represented, so the present gate's readiness question ("does this layer have a texture") could not
 * distinguish "held and correct" from "held and stale".
 *
 * Two things are asserted here, and the second is the one that matters:
 *
 *   1. The barrier HOLDS a mixed-generation frame while paused.
 *   2. The barrier does NOT hold a correctly-served frame. This is the failure mode a naive
 *      implementation ships with: a decoder returns the frame whose interval CONTAINS the request, so
 *      raw lag is uniformly [0, framePeriod) even when perfect. A threshold that ignores that fires on
 *      every frame of correct 24fps media, holds constantly, falls through to the escape hatch on
 *      every scrub, and adds latency while fixing nothing. A barrier that always fires is as useless
 *      as one that never fires — and both look "clean" if you only test the happy path.
 *
 * Mirrors the doctrine in `plans/flarex-evaluation-engine.md`: a mechanism must assert that it
 * actually engages, not merely that it is parity-clean.
 */

import {
  ASSUMED_MIN_FPS,
  COHERENCE_TOLERANCE_S,
  STALE_HOLD_MAX_MS,
  getCoherenceHoldEnabled,
  isStale,
  shouldHoldForCoherence,
  sourceFramePeriodSeconds,
  stalenessSeconds,
} from "./temporal-coherence";

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

/** Staleness for a source served the frame at-or-before `requested`, as a real decoder does. */
function servedByRealDecoder(requested: number, fps: number, speed = 1): number | null {
  const period = 1 / fps;
  const servedSourceTime = Math.floor(requested / period) * period;
  return stalenessSeconds({
    requestedSourceTime: requested,
    servedSourceTime,
    framePeriodSeconds: sourceFramePeriodSeconds(fps),
    speed,
  });
}

// ── 1. A correctly-served source is NEVER stale, at any rate, at any playhead ────────────────────
// The regression guard. `getFrame` walks to the last sample with timestamp <= requested, so raw lag
// spans [0, framePeriod) on perfect delivery — 0…41.7ms at 24fps. Sweeping sub-frame offsets across
// several rates is what catches a threshold that is really measuring frame rate.
{
  for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
    let worst = 0;
    for (let i = 0; i < 400; i += 1) {
      const requested = 3 + (i / 400) * (1 / fps) * 7; // sub-frame sweep across several frames
      const staleness = servedByRealDecoder(requested, fps);
      assert(!isStale(staleness), `${fps}fps correctly-served frame must not read stale (t=${requested.toFixed(5)})`);
      worst = Math.max(worst, staleness ?? 0);
    }
    assert(worst <= COHERENCE_TOLERANCE_S, `${fps}fps worst correct-delivery staleness ${worst} within tolerance`);
  }
}

// ── 2. The stagger this exists to catch IS caught ────────────────────────────────────────────────
// The reported symptom: sources 200–300ms apart. Also assert the boundary just past one frame period,
// so the gate is not merely "loose enough to pass test 1".
{
  const fps = 30;
  const period = 1 / fps;
  for (const behind of [0.2, 0.25, 0.3]) {
    const staleness = stalenessSeconds({
      requestedSourceTime: 5,
      servedSourceTime: 5 - behind,
      framePeriodSeconds: sourceFramePeriodSeconds(fps),
      speed: 1,
    });
    assert(isStale(staleness), `a source ${behind * 1000}ms behind must read stale`);
    assert(
      Math.abs((staleness ?? 0) - (behind - period)) < 1e-9,
      `staleness reports time behind BEYOND one frame period (${behind}s at ${fps}fps)`
    );
  }
  // Two frames behind is unambiguously stale; a hair over one period is the detection floor.
  assert(isStale(servedByRealDecoder(5, fps) === null ? null : (period * 2 - period) / 1), "2 frames behind is stale");
  const justOver = stalenessSeconds({
    requestedSourceTime: 5,
    servedSourceTime: 5 - (period + 0.01),
    framePeriodSeconds: sourceFramePeriodSeconds(fps),
    speed: 1,
  });
  assert(isStale(justOver), "one frame period + 10ms behind reads stale (detection floor)");
}

// ── 3. Unknowable and time-invariant sources never gate a present ────────────────────────────────
{
  const base = { requestedSourceTime: 5, framePeriodSeconds: 1 / 30, speed: 1 };
  eq(stalenessSeconds({ ...base, servedSourceTime: null }), null, "null served time → null staleness");
  eq(stalenessSeconds({ ...base, servedSourceTime: Number.NaN }), null, "NaN served time → null staleness");
  eq(stalenessSeconds({ ...base, requestedSourceTime: Number.NaN, servedSourceTime: 5 }), null, "NaN request → null");
  eq(stalenessSeconds({ ...base, servedSourceTime: 5, speed: 0 }), null, "zero speed has no rate → null, never ÷0");
  assert(!isStale(null), "null staleness is never stale");
}

// ── 4. Speed converts source time to TIMELINE time, so unlike clips stay comparable ──────────────
// A clip at 2× covers source time twice as fast, so a fixed source-time deficit is half the timeline
// deficit. Without this, two sources at different speeds could never agree on one timeline moment.
{
  const period = 1 / 30;
  const behind = period + 0.4;
  const at1x = stalenessSeconds({ requestedSourceTime: 9, servedSourceTime: 9 - behind, framePeriodSeconds: period, speed: 1 });
  const at2x = stalenessSeconds({ requestedSourceTime: 9, servedSourceTime: 9 - behind, framePeriodSeconds: period, speed: 2 });
  assert(Math.abs((at1x ?? 0) - 0.4) < 1e-9, "1× staleness is the raw source deficit past one frame");
  assert(Math.abs((at2x ?? 0) - 0.2) < 1e-9, "2× staleness is halved into timeline seconds");
  const reverse = stalenessSeconds({ requestedSourceTime: 9, servedSourceTime: 9 - behind, framePeriodSeconds: period, speed: -1 });
  assert(Math.abs((reverse ?? 0) - 0.4) < 1e-9, "reverse playback uses |speed| (sign is direction, not rate)");
}

// ── 5. Sources with no reported rate assume the SLOWEST normal material ──────────────────────────
// Only the WebCodecs provider carries nominalFps; <video>/settle cannot report one. Assuming slow is
// the safe direction — it can only make the gate more permissive, never hold correct media.
{
  eq(sourceFramePeriodSeconds(null), 1 / ASSUMED_MIN_FPS, "null fps → assumed period");
  eq(sourceFramePeriodSeconds(undefined), 1 / ASSUMED_MIN_FPS, "undefined fps → assumed period");
  eq(sourceFramePeriodSeconds(0), 1 / ASSUMED_MIN_FPS, "zero fps → assumed period");
  eq(sourceFramePeriodSeconds(Number.NaN), 1 / ASSUMED_MIN_FPS, "NaN fps → assumed period");
  eq(sourceFramePeriodSeconds(60), 1 / 60, "known fps → exact period");
  // A 60fps source served correctly but rate-blind (element path) must still not read stale.
  const blind = stalenessSeconds({
    requestedSourceTime: 5.017,
    servedSourceTime: 5,
    framePeriodSeconds: sourceFramePeriodSeconds(null),
    speed: 1,
  });
  assert(!isStale(blind), "rate-blind path does not hold a correctly-served frame");
}

// ── 6. The gate: holds while paused, never while playing ─────────────────────────────────────────
{
  const now = 10_000;
  const stale = ["flarexsrc:c1:media2"];
  const fresh = new Map<string, number>([["flarexsrc:c1:media2", now - 100]]);
  assert(
    shouldHoldForCoherence({ playing: false, staleIds: stale, staleSince: fresh, holdStartedMs: now - 100, nowMs: now, enabled: true }),
    "paused + a stale source → hold the present"
  );
  assert(
    !shouldHoldForCoherence({ playing: true, staleIds: stale, staleSince: fresh, holdStartedMs: now - 100, nowMs: now, enabled: true }),
    "PLAYING never holds — tolerateLag owns playback, transport is wall-clock servoed"
  );
  assert(
    !shouldHoldForCoherence({ playing: false, staleIds: [], staleSince: new Map(), holdStartedMs: null, nowMs: now, enabled: true }),
    "no stale sources → present"
  );
  assert(
    shouldHoldForCoherence({ playing: false, staleIds: stale, staleSince: new Map(), holdStartedMs: null, nowMs: now, enabled: true }),
    "the FIRST withheld frame of an episode holds (absent clocks = age 0, not instantly expired)"
  );
}

// ── 7. Escape hatch A (per source): a source that can never converge is written off ───────────────
// Without this, one dead source blocks every future frame. The episode cap alone does NOT cover it:
// the episode restarts after each forced present, so the viewer would update once per cap forever.
{
  const now = 10_000;
  const deadFor = new Map<string, number>([["dead-source", now - (STALE_HOLD_MAX_MS + 1)]]);
  assert(
    !shouldHoldForCoherence({
      playing: false,
      staleIds: ["dead-source"],
      staleSince: deadFor,
      holdStartedMs: now - 10,
      nowMs: now, enabled: true }),
    "a source stale past its own budget stops blocking (written off, viewer runs normally)"
  );
  const mixed = new Map<string, number>([
    ["dead-source", now - (STALE_HOLD_MAX_MS + 1)],
    ["converging-source", now - 50],
  ]);
  assert(
    shouldHoldForCoherence({
      playing: false,
      staleIds: ["dead-source", "converging-source"],
      staleSince: mixed,
      holdStartedMs: now - 50,
      nowMs: now, enabled: true }),
    "a written-off source does not stop us waiting for one still converging"
  );
}

// ── 8. Escape hatch B (per episode): staggered onsets cannot chain into an unbounded hold ────────
{
  const now = 10_000;
  // Every source is individually fresh, but the contiguous hold has already run past the ceiling.
  const allFresh = new Map<string, number>([["a", now - 10], ["b", now - 5]]);
  assert(
    !shouldHoldForCoherence({
      playing: false,
      staleIds: ["a", "b"],
      staleSince: allFresh,
      holdStartedMs: now - STALE_HOLD_MAX_MS,
      nowMs: now, enabled: true }),
    "the episode ceiling fires even when every individual source is still within budget"
  );
  assert(
    shouldHoldForCoherence({
      playing: false,
      staleIds: ["a", "b"],
      staleSince: allFresh,
      holdStartedMs: now - (STALE_HOLD_MAX_MS - 1),
      nowMs: now, enabled: true }),
    "just inside the episode ceiling still holds"
  );
}

// ── 8. STRESS: continuous randomized scrubbing over 3–5 CPU-starved sources ──────────────────────
// A single scripted scrub can miss races a real session hits. Model a paused viewer being scrubbed
// randomly while each source converges on its own independent, jittery schedule (the low-end machine:
// decoders time-slicing, one source arbitrarily starved). Two invariants must hold for every step:
//   (a) whenever the gate lets a frame through, every source is coherent — no mixed generations; and
//   (b) no source is held past the escape hatch — bounded degradation, never a deadlock.
{
  let rngState = 0x2f6e2b1;
  const rand = (): number => {
    // xorshift32 — deterministic, so a failure reproduces exactly.
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return ((rngState >>> 0) % 100000) / 100000;
  };

  for (const sourceCount of [3, 4, 5]) {
    const fpsChoices = [24, 30, 60];
    const sources = Array.from({ length: sourceCount }, (_, i) => ({
      id: `flarexsrc:comp:media${i}`,
      fps: fpsChoices[i % fpsChoices.length]!,
      // Source time this decoder has converged to. Starts adrift.
      served: 0,
      // A permanently starved source appears in the larger comps — the escape-hatch path.
      starved: sourceCount === 5 && i === 4,
    }));

    let nowMs = 0;
    let playhead = 0;
    const staleSince = new Map<string, number>();
    let presented = 0;
    let held = 0;
    let maxHoldMs = 0;
    let holdStartMs: number | null = null;

    for (let step = 0; step < 4000; step += 1) {
      nowMs += 8 + Math.floor(rand() * 25); // irregular composite cadence
      // Randomly scrub roughly every ~15 steps; otherwise the playhead is parked (paused viewer).
      if (rand() < 0.07) playhead = rand() * 30;

      // Each source converges toward the playhead at its own jittery rate.
      for (const s of sources) {
        if (s.starved) continue;
        const gap = playhead - s.served;
        if (Math.abs(gap) > 0) s.served += gap * (0.25 + rand() * 0.6);
        if (Math.abs(playhead - s.served) < 1 / s.fps) s.served = Math.floor(playhead * s.fps) / s.fps;
      }

      const staleIds: string[] = [];
      for (const s of sources) {
        const staleness = stalenessSeconds({
          requestedSourceTime: playhead,
          servedSourceTime: s.served,
          framePeriodSeconds: sourceFramePeriodSeconds(s.fps),
          speed: 1,
        });
        if (isStale(staleness)) staleIds.push(s.id);
      }

      for (const id of staleIds) if (!staleSince.has(id)) staleSince.set(id, nowMs);
      for (const id of [...staleSince.keys()]) if (!staleIds.includes(id)) staleSince.delete(id);

      const hold = shouldHoldForCoherence({ playing: false, staleIds, staleSince, holdStartedMs: holdStartMs, nowMs, enabled: true });
      if (hold) {
        held += 1;
        // Track the EPISODE (start of this contiguous hold → release), which is what the viewer
        // actually experiences and what `__flarexCoherence.maxHoldMs` reports. Deliberately NOT the
        // age of the oldest stale id: a permanently starved source stays in `staleIds` forever, but
        // once past the cap it no longer CAUSES a hold, so its age says nothing about the barrier.
        if (holdStartMs === null) holdStartMs = nowMs;
        continue;
      }

      const episodeMs = holdStartMs === null ? 0 : nowMs - holdStartMs;
      if (holdStartMs !== null) {
        maxHoldMs = Math.max(maxHoldMs, episodeMs);
        holdStartMs = null;
      }
      // (a) A present with stale sources is ONLY legal through one of the two escape hatches: the
      // episode ran past the ceiling, or every remaining stale source has been written off. Anything
      // else is a mixed-generation frame reaching the screen — the bug this exists to prevent.
      if (staleIds.length > 0) {
        const allWrittenOff = staleIds.every((id) => nowMs - (staleSince.get(id) ?? nowMs) >= STALE_HOLD_MAX_MS);
        assert(
          episodeMs >= STALE_HOLD_MAX_MS || allWrittenOff,
          `${sourceCount} sources: presented a mixed-generation frame after only ${episodeMs}ms ` +
            `with a source still converging (step ${step})`
        );
      }
      presented += 1;
    }

    // (b) Bounded: no hold EPISODE outlives the hatch by more than one composite interval — even with
    // a source that never converges at all. This is the "never a deadlock" half of the contract.
    assert(
      maxHoldMs <= STALE_HOLD_MAX_MS + 40,
      `${sourceCount} sources: longest hold episode ${maxHoldMs}ms stays bounded by STALE_HOLD_MAX_MS`
    );
    // The gate must actually engage AND actually release — a barrier stuck either way is worthless.
    assert(held > 0, `${sourceCount} sources: the barrier engaged during the scrub storm`);
    assert(presented > 0, `${sourceCount} sources: the barrier released — frames still reach the screen`);
    // ...and it must not cripple the viewer. One permanently starved source is the case that regressed
    // when the per-source write-off was replaced by an episode cap alone: 59 presents vs 3941 holds, a
    // viewer updating once every 1.5s. A third of composites presenting is the floor for "still usable".
    const presentRate = presented / (presented + held);
    assert(
      presentRate > 0.33,
      `${sourceCount} sources: viewer stays responsive (${(presentRate * 100).toFixed(1)}% of composites presented)`
    );
    console.log(
      `  ${sourceCount} sources: ${presented} presented / ${held} held, longest hold episode ${maxHoldMs}ms` +
        (sources.some((s) => s.starved) ? " (one permanently starved)" : "")
    );
  }
}

// ── 9. The flag suppresses the HOLD, never the measurement ──────────────────────────────────────
// Shipped OFF (2026-07-28): the first browser run measured 24.3s worst staleness and 44 of 47 hatch
// activations as per-source WRITE-OFFS — sources routinely never converge inside their budget. Holding
// then costs up to 1.5s and still ends in a mixed frame, so it is strictly worse than not holding
// until Track B bounds convergence. Staleness must keep being REPORTED with the flag off: that is the
// instrument Track B is measured with, and losing it would make the fix unmeasurable.
{
  const now = 10_000;
  const args = {
    playing: false,
    staleIds: ["src"],
    staleSince: new Map([["src", now - 10]]),
    holdStartedMs: now - 10,
    nowMs: now,
  };
  assert(shouldHoldForCoherence({ ...args, enabled: true }), "enabled → holds");
  assert(!shouldHoldForCoherence({ ...args, enabled: false }), "disabled → never holds, whatever the staleness");
  // Measurement is a separate function, unaffected by the flag by construction.
  assert(
    isStale(stalenessSeconds({ requestedSourceTime: 9, servedSourceTime: 4, framePeriodSeconds: 1 / 30, speed: 1 })),
    "staleness is still computed with the hold disabled (the Track B instrument)"
  );
  // The hold shipped OFF for one day on a measurement taken in a broken environment (DEV React
  // stalls, the getFrame duty cycle, and a missing media-end clamp). With those fixed it measures
  // 339ms average convergence and delivers the invariant, so it defaults ON. Pin that here: this
  // default is the difference between "presents one frame" and "fills in one source at a time".
  assert(getCoherenceHoldEnabled() === true, "the coherence hold defaults ON (escape hatch: ?flarexCoherence=0)");
}

// ── 10. Tail clamp: a request past the media end is NOT staleness ────────────────────────────────
// The regression that made this instrument unusable. `mapSourceTime` clamps the low end but not the
// high end, so a playhead past a clip's material produced ever-growing "staleness" while the decoder
// was correctly serving the last frame — every source in a comp reading 11-19s stale simultaneously.
{
  const fp = 1 / 30;
  // Playhead 20s past the end of 5s material: the last frame IS the correct frame.
  assert(
    stalenessSeconds({ requestedSourceTime: 25, servedSourceTime: 5, framePeriodSeconds: fp, speed: 1, mediaEndSeconds: 5 }) === 0,
    "request past media end reads 0 — there is no other frame to show"
  );
  // The clamp must not mask a source that is genuinely behind WITHIN the material.
  const real = stalenessSeconds({ requestedSourceTime: 4, servedSourceTime: 1, framePeriodSeconds: fp, speed: 1, mediaEndSeconds: 5 });
  assert(real !== null && real > 2.9, "real staleness inside the material still reports");
  // An unknown end must never make the reading worse than before the clamp existed.
  for (const end of [null, undefined, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const withEnd = stalenessSeconds({
      requestedSourceTime: 9,
      servedSourceTime: 4,
      framePeriodSeconds: fp,
      speed: 1,
      mediaEndSeconds: end as number | null,
    });
    const without = stalenessSeconds({ requestedSourceTime: 9, servedSourceTime: 4, framePeriodSeconds: fp, speed: 1 });
    assert(withEnd === without, `unknown media end (${String(end)}) leaves the reading unchanged`);
  }
  // Exactly at the end, and the last frame served for an end-of-media request, both stay coherent.
  assert(
    stalenessSeconds({ requestedSourceTime: 5, servedSourceTime: 5, framePeriodSeconds: fp, speed: 1, mediaEndSeconds: 5 }) === 0,
    "request exactly at the media end is coherent"
  );
  assert(
    !isStale(stalenessSeconds({ requestedSourceTime: 5, servedSourceTime: 5 - fp, framePeriodSeconds: fp, speed: 1, mediaEndSeconds: 5 })),
    "last frame served for an end-of-media request is coherent"
  );
  // The clamp must survive speed scaling (source seconds → timeline seconds).
  assert(
    stalenessSeconds({ requestedSourceTime: 50, servedSourceTime: 5, framePeriodSeconds: fp, speed: 2, mediaEndSeconds: 5 }) === 0,
    "tail clamp holds at speed != 1"
  );
}

console.log(`\ntemporal-coherence: ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
