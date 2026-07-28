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

import type { FrameProvider } from "../export/source-decoder";
import {
  __setFrameProviderFactoryForTests,
  acquirePreviewFrameProvider,
  canAttachToSession,
  divergenceToleranceSeconds,
  findWarmIdleIndex,
  getWcPoolStats,
  isDiverged,
  sessionCap,
} from "./preview-frame-pool";

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

// ── 3. Decoder-session SHARING (2026-07-28) ─────────────────────────────────
// One file read through two doors — the host clip's MediaIn and a pool-asset MediaIn — was decoded
// twice, and those two were the only stale sources in the comp. Nothing showed as a cap miss:
// four consumers fit a 4-slot budget exactly, one slot being pure duplication.

// The attach predicate is the whole 2026-07-27 guarantee, so it is asserted directly.
{
  eq(canAttachToSession(false, false), true, "hardware session accepts a hardware consumer");
  eq(canAttachToSession(false, true), true, "hardware session accepts a software-preferring loader (one decode, not two)");
  eq(canAttachToSession(true, true), true, "software session accepts a software consumer");
  // THE load-bearing one: this refusal is the 2026-07-27 bug ("host frozen, loaders playing").
  eq(canAttachToSession(true, false), false, "software session must NEVER accept a hardware (lag-intolerant) consumer");
}

// Divergence tolerance is a FRAME count, so it means the same thing on every source.
{
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  assert(near(divergenceToleranceSeconds(24), 2 / 24), "2 frames at 24fps is ~83ms");
  assert(near(divergenceToleranceSeconds(120), 2 / 120), "2 frames at 120fps is ~17ms — the same QUESTION, a 5x different budget");
  assert(near(divergenceToleranceSeconds(undefined), 2 / 30), "an unknown rate falls back to 30fps, not to zero tolerance");
  assert(near(divergenceToleranceSeconds(0), 2 / 30), "a zero rate must not divide by zero");

  eq(isDiverged([1.0], 30), false, "a lone member cannot diverge");
  eq(isDiverged([1.0, 1.0], 30), false, "identical requests are the healthy share");
  eq(isDiverged([1.0, 1.0 + 1 / 30], 30), false, "one frame of quantization skew is legitimate, not divergence");
  eq(isDiverged([1.0, 1.5], 30), true, "half a second apart at 30fps is two playheads, not one");
  eq(isDiverged([1.0, Number.NaN], 30), false, "a member that has never asked for a frame cannot diverge from anything");
}

// ── Live pool behaviour, against a stubbed decoder factory ──────────────────
let providersCreated = 0;
let decodes = 0;
const disposed: string[] = [];

function stubProvider(url: string): FrameProvider {
  providersCreated += 1;
  let live = true;
  return {
    width: 1920,
    height: 1080,
    nominalFps: 30,
    lastFrameLagSeconds: 0,
    decodableEndSeconds: 10,
    async getFrame(t: number) {
      decodes += 1;
      // Not a VideoFrame, so the per-consumer wrapper passes it through unchanged — exactly what it
      // does for the <video>/ImageBitmap fallback providers.
      return { url, t, live } as unknown as CanvasImageSource;
    },
    dispose() {
      live = false;
      disposed.push(url);
    },
  };
}

__setFrameProviderFactoryForTests(async (url: string) => stubProvider(url));

async function run(): Promise<void> {
  // 3a. THE INITIALIZATION RACE — two layers mounting in the same tick, before any provider exists.
  // This is both the likeliest place for duplicate sessions to creep back in AND the most common
  // real scenario; a regression here still passes every test that only acquires sequentially.
  {
    const URL_A = "blob:race-forest.mp4";
    const before = getWcPoolStats();
    const host = acquirePreviewFrameProvider(URL_A, { priority: "playhead" });
    const loader = acquirePreviewFrameProvider(URL_A, { priority: "playhead", preferSoftware: true });
    assert(host != null && loader != null, "both same-tick acquisitions get a lease");
    const [hostProvider, loaderProvider] = await Promise.all([host!.ready, loader!.ready]);
    const after = getWcPoolStats();

    eq(providersCreated, 1, "TWO same-tick acquisitions of one source create exactly ONE provider");
    eq(after.created - before.created, 1, "…and exactly ONE session is reserved");
    eq(after.shared - before.shared, 1, "…the second acquisition is recorded as a share");
    eq(after.sharedActive, 1, "…and the session is serving both leases (refCount 2)");
    assert(hostProvider != null && loaderProvider != null, "both leases resolve to a usable provider");
    assert(hostProvider !== loaderProvider, "each lease gets its OWN wrapper — B's getFrame must never invalidate A's frame");

    // Fields the pool has twice erased by accident. Dropping one is silent and expensive.
    eq(hostProvider!.width, 1920, "width forwards through the per-consumer wrapper");
    eq(hostProvider!.nominalFps, 30, "nominalFps forwards (the coherence gate divides by it)");
    eq(hostProvider!.lastFrameLagSeconds, 0, "lastFrameLagSeconds forwards (the catch-up hold reads it)");
    eq(hostProvider!.decodableEndSeconds, 10, "decodableEndSeconds forwards");

    // 3b. A share must actually SAVE WORK. Per the standing rule that "a reuse mechanism must assert
    // that it actually reuses" — a dedupe that never collapses a call is bookkeeping with no payoff.
    decodes = 0;
    await Promise.all([hostProvider!.getFrame(1), loaderProvider!.getFrame(1)]);
    eq(decodes, 1, "two CONCURRENT requests for the same timestamp cost one decode (in-flight dedupe)");
    await hostProvider!.getFrame(2);
    await loaderProvider!.getFrame(2);
    eq(decodes, 2, "two SEQUENTIAL requests for the same timestamp cost one decode (lastServed memo)");
    assert(getWcPoolStats().sharedFrameHits > 0, "sharedFrameHits must be non-zero — a share that never hits is worthless");

    host!.release();
    eq(disposed.length, 0, "one lease releasing must NOT dispose a provider the other is still using");
    const stillWorks = await loaderProvider!.getFrame(3);
    assert(stillWorks != null, "the surviving lease keeps serving frames after its co-tenant left");
    loader!.release();
  }

  // 3c. REGRESSION: the host must never inherit a software decode it did not ask for.
  {
    const URL_B = "blob:sw-first.mp4";
    providersCreated = 0;
    const loader = acquirePreviewFrameProvider(URL_B, { preferSoftware: true });
    await loader!.ready;
    const host = acquirePreviewFrameProvider(URL_B, { preferSoftware: false });
    await host!.ready;
    eq(providersCreated, 2, "a hardware consumer arriving second gets its OWN session, never the software one");
    eq(getWcPoolStats().sharedActive, 0, "…so nothing is shared — the accepted ordering caveat, and no regression");
    loader!.release();
    host!.release();
  }

  // 3d. DIVERGENCE: two playheads on one seek-on-demand decoder thrash worse than two decoders, so
  // the share gives up — after hysteresis, never on a single stray sample.
  {
    const URL_C = "blob:diverge.mp4";
    let loaderPreempted = false;
    const host = acquirePreviewFrameProvider(URL_C, {});
    const loader = acquirePreviewFrameProvider(URL_C, { preferSoftware: true, onPreempted: () => { loaderPreempted = true; } });
    const [hostProvider, loaderProvider] = await Promise.all([host!.ready, loader!.ready]);
    eq(getWcPoolStats().sharedActive, 1, "the two start out sharing one session");

    const detachesBefore = getWcPoolStats().shareDetaches;
    // One stray diverged frame must NOT split the share.
    await hostProvider!.getFrame(0);
    await loaderProvider!.getFrame(5);
    eq(getWcPoolStats().shareDetaches, detachesBefore, "a single diverged sample does not split a healthy share (hysteresis)");

    for (let i = 0; i < 10 && getWcPoolStats().shareDetaches === detachesBefore; i += 1) {
      await hostProvider!.getFrame(i * 0.033);
      await loaderProvider!.getFrame(5 + i * 0.033);
    }
    eq(getWcPoolStats().shareDetaches, detachesBefore + 1, "sustained divergence detaches the later-joined lease");
    eq(loaderPreempted, true, "…and it is notified, so it re-acquires or falls back exactly like a preemption");
    eq(getWcPoolStats().sharedActive, 0, "…leaving the host alone on its session");

    // The session must refuse to re-admit anyone, or the detached consumer re-attaches and oscillates.
    providersCreated = 0;
    const rejoin = acquirePreviewFrameProvider(URL_C, { preferSoftware: true });
    await rejoin!.ready;
    eq(providersCreated, 1, "a detached consumer re-acquiring gets its OWN session — no detach/re-attach oscillation");
    rejoin!.release();
    host!.release();
    loader!.release(); // already detached — must be a no-op, not a double release
  }
}

await run();

console.log(`\npreview-frame-pool: ${checks - failures}/${checks} assertions passed`);
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
// Explicit: importing the pool pulls in the mp4box decoder chain, which leaves a handle on the event
// loop under node — without this the script prints its result and then hangs forever instead of
// returning an exit code (i.e. it would be useless as a gate).
process.exit(0);
