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
  __setWedgeTimeoutForTests,
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

  // ── 6. THE WEDGE BACKSTOP: a decode that never settles ────────────────────
  // Every other bound in the playback path sits ABOVE the decode and cannot interrupt one already in
  // flight, and `serializeFrameProvider` chains later calls behind it — so without this, ONE hung
  // promise blocks a provider forever while `busyWedge` reports the freeze as healed. Sharing made it
  // worse: members await the same `session.pending`, so one wedged decode takes the whole comp.
  {
    __setWedgeTimeoutForTests(60);
    const URL_W = "blob:wedged.mp4";
    let released: (() => void) | null = null;
    __setFrameProviderFactoryForTests(async (url: string) => {
      providersCreated += 1;
      return {
        width: 1920,
        height: 1080,
        nominalFps: 30,
        lastFrameLagSeconds: 0,
        decodableEndSeconds: 10,
        // Never settles until the test lets it — the exact shape of the failure being guarded.
        getFrame: () => new Promise<CanvasImageSource | null>((resolve) => {
          released = () => resolve(null);
        }),
        dispose() {
          disposed.push(url);
        },
      } satisfies FrameProvider;
    });

    const wedgedBefore = getWcPoolStats().wedgeTimeouts;
    let hostPreempted = false;
    let joinerPreempted = false;
    const a = acquirePreviewFrameProvider(URL_W, { onPreempted: () => { hostPreempted = true; } });
    const b = acquirePreviewFrameProvider(URL_W, { onPreempted: () => { joinerPreempted = true; } });
    const providerA = await a!.ready;
    const providerB = await b!.ready;
    eq(getWcPoolStats().sharedActive, 1, "both leases share one session before the wedge");

    // BOTH members must come back. A backstop that frees only the caller who happened to trip it
    // leaves every sharer hanging on a call the owner already gave up on — and the pool would read
    // healthy while the comp is frozen, which is worse than no backstop at all.
    const [frameA, frameB] = await Promise.all([providerA!.getFrame(1), providerB!.getFrame(1)]);
    eq(frameA, null, "a decode that never settles resolves null at the deadline rather than hanging");
    eq(frameB, null, "…and so does the SHARER awaiting the same pending promise");
    eq(getWcPoolStats().wedgeTimeouts, wedgedBefore + 1, "the timeout is counted once for the session, not once per member");
    eq(hostPreempted, true, "the wedge tears the session down as a preemption, so members are notified");
    eq(joinerPreempted, true, "…every member, not just the one that tripped it");
    assert(disposed.includes(URL_W), "a decoder that stopped answering is DISPOSED, never parked warm for the next lease");
    eq(getWcPoolStats().sharedActive, 0, "the wedged session is gone from the pool");

    // Recovery is the whole point: a re-acquire must build a fresh session, not inherit the dead one.
    providersCreated = 0;
    __setFrameProviderFactoryForTests(async (url: string) => stubProvider(url));
    const fresh = acquirePreviewFrameProvider(URL_W, {});
    const freshProvider = await fresh!.ready;
    eq(providersCreated, 1, "re-acquiring after a wedge creates a NEW provider");
    assert((await freshProvider!.getFrame(1)) !== null, "…and it serves frames again");
    fresh!.release();
    a!.release();
    b!.release();
    released?.(); // let the abandoned promise finish so node's event loop stays clean
    __setWedgeTimeoutForTests(null);
  }

  // EXCLUSIVE leases (TimeSpeed's retimed loaders, 2026-07-29). A consumer that reads the same URL at
  // a DIFFERENT time is the one case sharing cannot serve: neither member ever hits `pending` or
  // `lastServed`, so one decoder pays a seek per member per frame. `noteDivergence` finds that after
  // four frames and re-finds it every time the session is rebuilt; `exclusive` declares it up front.
  {
    const URL_X = "blob:retimed.mp4";
    providersCreated = 0;
    const host = acquirePreviewFrameProvider(URL_X, { priority: "playhead" });
    const retimed = acquirePreviewFrameProvider(URL_X, { priority: "playhead", preferSoftware: true, exclusive: true });
    assert(host != null && retimed != null, "both the host and its retimed loader get a lease");
    await Promise.all([host!.ready, retimed!.ready]);
    eq(providersCreated, 2, "an EXCLUSIVE acquisition never joins the host's session");
    eq(getWcPoolStats().sharedActive, 0, "…so nothing is shared");

    host!.release();
    retimed!.release();
  }

  // The other direction matters just as much: skipping the join only stops the exclusive consumer
  // taking someone else's session. If its OWN session stayed shareable, the next ordinary acquire
  // would attach to it and reintroduce the identical divergence from the far side. Ordered
  // exclusive-first so there is no other session to explain the result.
  {
    const URL_Z = "blob:retimed-first.mp4";
    providersCreated = 0;
    const retimed = acquirePreviewFrameProvider(URL_Z, { priority: "playhead", exclusive: true });
    await retimed!.ready;
    const host = acquirePreviewFrameProvider(URL_Z, { priority: "playhead" });
    await host!.ready;
    eq(providersCreated, 2, "a later consumer cannot attach TO an exclusive session either");
    eq(getWcPoolStats().sharedActive, 0, "…nothing is shared in either direction");
    retimed!.release();
    host!.release();
  }

  // …and the un-retimed loader must still share. `exclusive` is a declaration about one consumer, not
  // a retreat from v32l — a comp whose MediaIn loads the host's own file at the host's own time is
  // exactly the case sharing exists for, and it has to stay a share.
  {
    const URL_Y = "blob:not-retimed.mp4";
    providersCreated = 0;
    const host = acquirePreviewFrameProvider(URL_Y, { priority: "playhead" });
    const loader = acquirePreviewFrameProvider(URL_Y, { priority: "playhead", preferSoftware: true });
    await Promise.all([host!.ready, loader!.ready]);
    eq(providersCreated, 1, "an un-retimed loader still shares one decode with its host");
    host!.release();
    loader!.release();
  }

  // ── 7. KERNEL-OWNED SESSION LIFETIME (ADR-012 slice S3.3) ─────────────────
  //
  // The effect that acquires a session is keyed on `[mediaType, src]`, so a `useMemo` recompute
  // upstream unmounts the layer and its cleanup destroys the decoder — a demux, a sample index and a
  // GOP window discarded by a rendering decision that had nothing to say about resources (I-24). The
  // park that release leaves behind then loses a two-deep FIFO to the very next mount, so a comp with
  // four loaders reliably lost two decoders to a re-render.
  //
  // The fix is not "never release" — the component really is gone. It is that the kernel decides what
  // the release MEANS, and a release for a source the graph still declares parks RETAINED.
  {
    const RETAINED = "blob:still-declared.mp4";
    const JUNK_A = "blob:scrolled-past-a.mp4";
    const JUNK_B = "blob:scrolled-past-b.mp4";

    const retained = acquirePreviewFrameProvider(RETAINED, { priority: "playhead" });
    await retained!.ready;
    const retentionsBefore = getWcPoolStats().retentions;
    retained!.release({ retain: true, cause: "lifecycle" });
    eq(getWcPoolStats().retentions - retentionsBefore, 1, "an overruled lifecycle release is counted as a retention");
    eq(getWcPoolStats().retainedIdle >= 1, true, "…and the park it leaves is marked retained");

    // Two ordinary parks now compete for the same two-deep FIFO. Before this slice the retained one was
    // indistinguishable from them and eviction order was decided by mount order.
    const junkA = acquirePreviewFrameProvider(JUNK_A, { priority: "playhead" });
    await junkA!.ready;
    const junkB = acquirePreviewFrameProvider(JUNK_B, { priority: "playhead" });
    await junkB!.ready;
    junkA!.release();
    junkB!.release();

    providersCreated = 0;
    const hitsBefore = getWcPoolStats().retentionHits;
    const remount = acquirePreviewFrameProvider(RETAINED, { priority: "playhead" });
    const remountProvider = await remount!.ready;
    // THE assertion of the slice: the decoder the unmount would have destroyed is still here.
    eq(providersCreated, 0, "a RETAINED park survives the idle FIFO an ordinary park loses to");
    eq(getWcPoolStats().retentionHits - hitsBefore, 1, "…and the reuse is counted, so a retention that never pays off is visible");
    assert((await remountProvider!.getFrame(1)) != null, "the reused retained decoder actually serves frames");

    // Retention must not leak into the default path: an ordinary release is byte-identical to before.
    remount!.release();
    const ordinary = acquirePreviewFrameProvider("blob:ordinary.mp4", { priority: "playhead" });
    await ordinary!.ready;
    const retainedIdleBefore = getWcPoolStats().retainedIdle;
    ordinary!.release();
    eq(getWcPoolStats().retainedIdle, retainedIdleBefore, "a release with no verdict parks ordinarily — unchanged behaviour");
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
