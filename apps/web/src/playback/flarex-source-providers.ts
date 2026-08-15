/**
 * ADR-021 step 2 — the Flarex compositor's media boundary, as a PULL against a BYTE budget.
 *
 * WHAT THIS REPLACES, and why it is not a second engine. Every asset-source `MediaIn` used to acquire
 * its pixels from `preview-frame-pool`, which is a SESSION pool: it caps concurrent decoders at
 * `MAX_WC_TOTAL_SESSIONS` (4) with one hardware slot reserved, so **the Flarex loader ceiling is 3 on
 * every host**, and the 4th MediaIn is denied at mount and never re-admitted (DEBT-013 clause (a)).
 * That cap is correct for the timeline, where a small fixed number of clips play at once. It is wrong
 * for a compositor, where the number of live sources is a property of the user's graph.
 *
 * The replacement is not new machinery. `createFrameProvider` is the SAME constructor the pool uses and
 * the SAME one the export path already pulls through (`SceneFrameCompositor.gradeMediaLayer` does
 * `await source.getFrame(t)`), so preview and export converge on one media interface instead of two
 * kept in agreement by gates (ADR-021 §1). What changes is the admission rule: a provider here holds no
 * session, claims no slot and has no priority (I-P1), and the set is bounded by RESIDENT BYTES rather
 * than by a count (I-P6).
 *
 * ── WHY BYTES, NOT A COUNT ───────────────────────────────────────────────────────────────────────
 * DEBT-019's Detection clause is explicit that a count-denominated budget *extends* that debt: a count
 * proxies bytes only while clip lengths are similar, which is the assumption that broke. So every
 * number in this file is bytes, and `flarexProviderResidency()` reports bytes.
 *
 * ── WHERE THE PER-PROVIDER CHARGE COMES FROM ─────────────────────────────────────────────────────
 * Measured, not estimated — DEBT-019's phase-1 attribution (`tmp/debt019-attribution-probe.ts`), a
 * per-term ablation over the REAL provider internals plus a heap snapshot with retainer paths. N=100,
 * 1280x720, working-set MB per source, on two corpora differing only in duration (3s vs 120s):
 *
 *   stage                            3s      120s
 *   byte source only                2.42     3.14    (nothing retained; browser/network overhead)
 *   + sample index                  2.46     2.87    (25 B x samples, as designed)
 *   + chunk window                  2.76     3.02    (bounded by WINDOW_MAX_SPAN_BYTES)
 *   + configured VideoDecoder       2.95     3.60    (allocation, nothing decoded)
 *   + ONE pull                     22.40    23.39    (+19.5 to +19.8 — and the two corpora AGREE)
 *
 * Everything before decode is under 1 MB/source. **The whole cost is decoded frames**, and it is
 * duration-INDEPENDENT: one pull costs ~20 MB whether the clip is 3 seconds or two minutes.
 *
 * The heap snapshot with retainer paths names the holder rather than inferring it. It also exonerates
 * the JS heap outright — total JS self size differs by 0.09 MB/source between the corpora while the
 * working set differs by ~15 — because a `VideoFrame`'s pixels are renderer/GPU memory that no JS heap
 * number includes. What the snapshot counts instead is instances: 8.64 live `VideoFrame`s per provider,
 * retained through the provider closure's own decoded-frame array.
 *
 * So the charge is derived from the frame's GEOMETRY, the only thing it actually depends on:
 * {@link PINNED_FRAMES_PER_PROVIDER} x one NV12 frame.
 */

import { createFrameProvider, type FrameProvider } from "../export/source-decoder";
import type { PreviewFrameLease } from "./preview-frame-pool";

/**
 * Frame-equivalents a live provider holds once it has served one.
 *
 * TWO READINGS, and they deliberately do not agree — stating both is the point:
 *   - the heap snapshot counts **8.64** live `VideoFrame` instances per provider, which is exactly the
 *     decoder's own steady state (`OUTPUT_MAX` = 8 queued outputs plus `current`);
 *   - the working-set ablation prices the decode step at **~20 MB/source**, which at 1280x720 NV12
 *     (1.38 MB) is **~14.5** frame-equivalents.
 * The gap is real memory with no JS object to count it: the decoder's reorder buffer and the GPU-side
 * backing of frames whose JS shell is 100 bytes. A budget built on the instance count alone would
 * under-charge by ~40% and over-admit accordingly, so the charge follows the WORKING SET — the thing
 * that actually kills the tab — and 16 is that reading rounded up.
 *
 * NOT a tuning knob. If `OUTPUT_MAX`/`WARMUP_MAX` in `webcodecs-decoder.ts` change, this changes with
 * them or the budget silently stops describing the thing it bounds.
 */
const PINNED_FRAMES_PER_PROVIDER = 16;

/**
 * Everything that is NOT decoded frames, from the same ablation: byte source + sample index + chunk
 * window + decoder allocation = 2.95 MB/source (3s) / 3.60 MB (120s) at N=100. Charged flat because
 * measurement says it is flat — the index is 25 B x samples (0.086 MB for a 2-minute 30fps source)
 * and the window is capped at `WINDOW_MAX_SPAN_BYTES` regardless of clip length.
 */
const PROVIDER_FIXED_BYTES = 3 * 1024 * 1024;

/** Before a provider exists its frame size is unknown; charge a 1080p-shaped provisional so a burst of
 *  simultaneous mounts cannot over-commit the budget, then re-charge the real figure on ready. */
const PROVISIONAL_FRAME_WIDTH = 1920;
const PROVISIONAL_FRAME_HEIGHT = 1080;

/**
 * THE BUDGET. 768 MB of live provider residency.
 *
 * Chosen against the two measurements that bracket it, not by feel:
 *   - the CEILING it must stay under: ADR-021 §3.2(a) measured a browser tab not surviving ~2.5 GB of
 *     provider residency at N=100. A budget must leave room for the compositor's own RTTs, the
 *     timeline's decoders and the page; 768 MB is under a third of the figure that killed the tab.
 *   - the FLOOR it must clear: the thing being fixed. At the 22.1 MB/provider that 1280x720 proxy media
 *     actually costs, this admits ~34 concurrent sources against today's 3.
 * At un-proxied 1080p (49.7 MB/provider) it admits ~15, which is the honest answer for that media and
 * is still five times the current ceiling.
 *
 * Deliberately NOT derived from `deviceMemory` or any host probe. A budget that varies by machine makes
 * every bug report unreproducible, and ADR-021 §3.5's limits were measured on one machine class.
 */
const DEFAULT_BUDGET_BYTES = 768 * 1024 * 1024;

let budgetBytes = DEFAULT_BUDGET_BYTES;

function frameBytes(width: number, height: number): number {
  return Math.ceil(Math.max(1, width) * Math.max(1, height) * 1.5);
}

/** What one live provider costs, in bytes. See the header for where each term is measured. */
function providerBytes(width: number, height: number): number {
  return PROVIDER_FIXED_BYTES + PINNED_FRAMES_PER_PROVIDER * frameBytes(width, height);
}

interface Entry {
  readonly url: string;
  readonly software: boolean;
  /** Null while constructing, or after an eviction disposed it — the next pull rebuilds. */
  provider: FrameProvider | null;
  building: Promise<BuildOutcome> | null;
  /** Bytes currently charged to the budget for this entry (provisional until the frame size is known). */
  chargedBytes: number;
  /** `performance.now()` of the last `getFrame`. The eviction ordering, and the liveness proof. */
  lastPullMs: number;
  /** Live leases on this entry. An entry with none is disposed outright rather than evicted. */
  refCount: number;
  evictions: number;
  pulls: number;
  disposed: boolean;
  /** Serializes `getFrame` across every owner of this entry — see {@link guardWedge}. */
  chain: Promise<unknown>;
  /** When the last lease went away, or 0 while leased. Unleased entries are evicted first. */
  releasedAtMs: number;
}

const entries = new Map<string, Entry>();
let heldBytes = 0;
const stats = {
  evictions: 0,
  rebuilds: 0,
  admissions: 0,
  denials: 0,
  peakHeldBytes: 0,
  /**
   * LIVENESS, and it is not optional. The measurement-preconditions rule forbids trusting a number
   * before the subsystem it describes is proven to have run — and a byte budget is exactly the kind of
   * number that looks healthy when nothing is pulling at all. `pulls` counts `getFrame` calls reaching
   * the façade; `framesServed` counts the ones that came back with a picture. `live` providers with
   * zero pulls, or pulls with zero frames, means the budget is describing a set that is not working.
   */
  pulls: 0,
  framesServed: 0,
  nulls: 0,
  /** Decodes abandoned at {@link GETFRAME_WEDGE_MS}. Non-zero means providers are breaking, not queuing. */
  wedges: 0,
  /**
   * WHERE a pull is right now. `pulls - framesServed - nulls` says how many are outstanding but not
   * WHICH await they sit in, and the two have opposite fixes: waiting on CONSTRUCTION is an admission
   * problem, waiting on DECODE is a throughput problem. Two acceptance runs were spent guessing between
   * them from the outstanding count alone.
   */
  awaitingBuild: 0,
  awaitingDecode: 0,
  /**
   * Pulls that ended because their build came back `"failed"` or `"budget"`. Counted because they
   * previously exited with NO counter at all: an acceptance run read `pulls 25 · served 3 · nulls 0 ·
   * in-flight 0`, which does not add up, and the 22 missing pulls were invisible by construction.
   * A ledger that does not balance must say so. Read it WITH `buildAbandoned`, which attributes how
   * many of these were ordinary remount churn rather than a source that cannot be decoded.
   */
  buildFailures: 0,
  /**
   * Builds abandoned because the ENTRY WAS RELEASED while its construction was in flight — a React
   * remount, a `src` flip to the ingest-proxy variant, a comp closing. Split out of `buildFailures`
   * because conflating them makes a healthy number look alarming and hides a real one behind it:
   * `admitAndBuild`'s `entry.disposed` branch returns the same `"failed"` string as a codec the
   * decoder genuinely cannot open, and step-2 acceptance runs read `build-failures 5-7` on a fixture
   * where all twelve sources decoded perfectly. Churn is expected and self-correcting; an
   * undecodable source is neither, and the consumer takes its `<video>` fallback for it.
   */
  buildAbandoned: 0,
};

/**
 * Live residency, in BYTES, for whatever enforces I-P6 and for the probes that verify it.
 *
 * `providers` is reported alongside the bytes and is NOT the budget's unit — it is there so a reader
 * can see the two diverge (which is the entire point of DEBT-019's Detection clause).
 */
export function flarexProviderResidency(): {
  budgetBytes: number;
  heldBytes: number;
  providers: number;
  live: number;
  evictions: number;
  rebuilds: number;
  admissions: number;
  denials: number;
  peakHeldBytes: number;
} {
  let live = 0;
  for (const entry of entries.values()) if (entry.provider) live += 1;
  return { budgetBytes, heldBytes, providers: entries.size, live, ...stats };
}

/** Test/probe seam. Setting a budget evicts down to it immediately. */
export function setFlarexProviderBudgetBytes(bytes: number): void {
  budgetBytes = Math.max(0, bytes);
  evictDownTo(0);
}

if (typeof window !== "undefined") {
  try {
    Object.defineProperty(window, "__rfFlarexProviders", { configurable: true, get: () => flarexProviderResidency() });
  } catch {
    /* read-only window in some embeds — telemetry is best-effort */
  }
}

/**
 * EVICTION POLICY — a decision, per I-P9, and NOT plain LRU.
 *
 * I-P9 disqualifies LRU for the frame cache because looping a range larger than capacity makes LRU
 * evict precisely the frame needed next. The ADR is equally explicit that a claim proven about one
 * cache does not transfer to the other, so the question has to be asked again here rather than
 * inherited — and asked honestly, because the answer is NOT simply "LRU is fine for providers".
 *
 * For a provider set the access pattern is: every source the graph reaches is pulled once per frame,
 * in graph order. While the set FITS the budget that is not cyclic in any meaningful sense — a source
 * that stops being pulled (a disconnected branch, a comp whose proxy is serving, a loader past its
 * media end) is genuinely idle and is exactly the right victim, and last-pull time identifies it with
 * no priority channel at all. That is why {@link acquireFlarexSourceProvider} has no priority
 * argument: not pulling IS the demotion.
 *
 * But when the set OVER-SUBSCRIBES the budget, the pattern becomes precisely I-P9's worst case: N
 * sources pulled in a fixed order every frame, capacity < N, and the least-recently-pulled is always
 * the one about to be pulled. So the policy is split at that boundary:
 *
 *   - a candidate not pulled during the current frame  → evict the least recently pulled (correct,
 *     cheap, and it never touches a source that is on screen);
 *   - every candidate pulled this frame (over-subscription) → evict at RANDOM, which is what I-P9's
 *     own measurement shows degrades gracefully on cyclic access where LRU degrades to 0%.
 */
const FRAME_WINDOW_MS = 100;

function pickVictim(protectUrl: string): Entry | null {
  const now = performance.now();
  let coldest: Entry | null = null;
  let unleased: Entry | null = null;
  const hotCandidates: Entry[] = [];
  for (const entry of entries.values()) {
    if (entry.url === protectUrl || !entry.provider) continue;
    // An entry no consumer holds is retained only against a re-mount; it is strictly the cheapest
    // thing to lose and is taken before any live source is touched.
    if (entry.refCount === 0) {
      if (!unleased || entry.releasedAtMs < unleased.releasedAtMs) unleased = entry;
      continue;
    }
    if (now - entry.lastPullMs > FRAME_WINDOW_MS) {
      if (!coldest || entry.lastPullMs < coldest.lastPullMs) coldest = entry;
    } else hotCandidates.push(entry);
  }
  if (unleased) return unleased;
  if (coldest) return coldest;
  if (!hotCandidates.length) return null;
  return hotCandidates[Math.floor(Math.random() * hotCandidates.length)] ?? null;
}

/**
 * Dispose an entry's provider, keeping the entry so the next pull rebuilds it (I-P6).
 *
 * `counted` separates the two callers, because conflating them would corrupt the one number that says
 * whether the budget is thrashing: a BUDGET eviction is a provider taken from a consumer that still
 * wants it, while a RELEASE is a consumer that has gone away. Counting a release as an eviction would
 * make a comp being closed look like budget pressure.
 */
function evictProvider(entry: Entry, counted: boolean): void {
  if (!entry.provider) return;
  try {
    entry.provider.dispose();
  } catch {
    /* a provider that throws on dispose is already gone */
  }
  entry.provider = null;
  heldBytes -= entry.chargedBytes;
  entry.chargedBytes = 0;
  if (counted) {
    entry.evictions += 1;
    stats.evictions += 1;
  }
}

/** Free space until `heldBytes + incoming <= budgetBytes`, or until nothing can be freed. */
function evictDownTo(incoming: number, protectUrl = ""): boolean {
  while (heldBytes + incoming > budgetBytes) {
    const victim = pickVictim(protectUrl);
    if (!victim) return heldBytes + incoming <= budgetBytes;
    evictProvider(victim, true);
  }
  return true;
}

function charge(entry: Entry, bytes: number): void {
  heldBytes += bytes - entry.chargedBytes;
  entry.chargedBytes = bytes;
  if (heldBytes > stats.peakHeldBytes) stats.peakHeldBytes = heldBytes;
}

/**
 * A construction attempt's outcome. The distinction between the last two is the whole of DEBT-013:
 *
 *   provider   built and charged.
 *   "budget"   no room right now. **RECOVERABLE** — the entry keeps its façade, `getFrame` answers
 *              null, and the consumer's existing tolerant-retry loop re-asks until space frees. This
 *              must never reach the consumer as a lease failure.
 *   "failed"   `createFrameProvider` could not decode this URL at all (codec, container). NOT a budget
 *              matter and not recoverable by waiting, so the consumer takes its `<video>` fallback —
 *              which is the correct answer for an undecodable source and the behaviour it has today.
 */
type BuildOutcome = FrameProvider | "budget" | "failed";

/**
 * BOUNDED-CONCURRENCY ADMISSION, and both bounds are there because a run measured the alternative.
 *
 * **Why not unbounded.** The first acceptance run bound 12 MediaIns and the budget **denied 9** with a
 * peak charge of 757 MB against 768 MB, having evicted nothing. A comp mounts all its loaders in one
 * tick, so twelve constructions were in flight together, each holding a PROVISIONAL 1080p charge
 * (50.5 MB) and none of them yet evictable — `pickVictim` skips an entry with no live provider, so
 * there was no victim and the only move left was to refuse.
 *
 * **Why not fully serial**, which was the first fix and is what this replaces. It did remove the
 * denials (9 → 0, peak 757 → 252 MB) but put the tail of the queue behind every construction ahead of
 * it, and `WebglMediaLayer`'s 4 s init-hang net then fired and dropped those loaders to `<video>`:
 * the same run went from 9 denied to 2 on the element path. A ceiling moved is not a ceiling removed.
 *
 * So: several at a time. The number is bounded on BOTH sides by measurement, not picked:
 *   · below — 3 was too few. Cold construction of un-proxied 1080p originals is seconds, not the
 *     94–238 ms of ADR-021 §7's proxy media, so 12 sources took four waves and an acceptance run read
 *     **pulls 25, frames served 2** with 23 calls still queued behind a build at the end of a 20 s
 *     settle. A consumer waiting on construction is a consumer not rendering, whatever the books say.
 *   · above — the in-flight provisional charge is `ADMISSION_CONCURRENCY × 50.5 MB` (1080p), so 8 is
 *     404 MB, still inside the 768 MB budget with room for the providers already live. Unbounded is
 *     what produced the 9 denials.
 */
const ADMISSION_CONCURRENCY = 8;
let admissionsInFlight = 0;
const admissionWaiters: (() => void)[] = [];

async function acquireAdmissionSlot(): Promise<void> {
  if (admissionsInFlight < ADMISSION_CONCURRENCY) {
    admissionsInFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => admissionWaiters.push(resolve));
  admissionsInFlight += 1;
}

function releaseAdmissionSlot(): void {
  admissionsInFlight -= 1;
  admissionWaiters.shift()?.();
}

async function buildProvider(entry: Entry): Promise<BuildOutcome> {
  await acquireAdmissionSlot();
  try {
    return await admitAndBuild(entry);
  } finally {
    releaseAdmissionSlot();
  }
}

async function admitAndBuild(entry: Entry): Promise<BuildOutcome> {
  if (entry.disposed) return "failed";
  const provisional = providerBytes(PROVISIONAL_FRAME_WIDTH, PROVISIONAL_FRAME_HEIGHT);
  // Admission is a BYTE decision and it is made BEFORE the expensive construction, so a comp mounting
  // twenty loaders in one tick cannot build twenty decoders and then discover it could not afford them.
  if (!evictDownTo(provisional, entry.url)) {
    stats.denials += 1;
    return "budget";
  }
  charge(entry, provisional);
  let provider: FrameProvider | null = null;
  try {
    provider = await createFrameProvider(entry.url, "video", {
      // Flarex loaders decode in SOFTWARE so they do not contend with the timeline host for the GPU's
      // single H.264 block — the confirmed multi-source freeze cause. Unchanged from the pool path.
      preferSoftware: entry.software,
      // The preview's blocking budget: a getFrame that cannot finish in time returns the CURRENT frame
      // with its real lag rather than stalling the compositor. Same value the pool used.
      frameBudgetMs: 24,
    });
  } catch {
    provider = null;
  }
  if (entry.disposed) {
    try {
      provider?.dispose();
    } catch {
      /* nothing to do */
    }
    charge(entry, 0);
    // The consumer went away mid-build, which is ordinary remount churn — NOT an undecodable source.
    // Same return value (the caller's handling is identical), different counter. See `buildAbandoned`.
    stats.buildAbandoned += 1;
    return "failed";
  }
  if (!provider) {
    charge(entry, 0);
    return "failed";
  }
  // Re-charge at the real geometry now that it is known. A CREDIT for proxy media (1280x720 against a
  // 1080p provisional); exact for a 1080p source.
  charge(entry, providerBytes(provider.width || PROVISIONAL_FRAME_WIDTH, provider.height || PROVISIONAL_FRAME_HEIGHT));
  entry.provider = provider;
  return provider;
}

/** A decode that has not answered in this long is broken, not slow — the pool's own figure. */
const GETFRAME_WEDGE_MS = 10_000;

/**
 * Bound one decode. Resolves null at the deadline and NEVER rejects: every caller already handles a
 * null frame (it is the decoder-bailed path), and a rejection here would surface as an unhandled error
 * inside the layer's rAF loop.
 *
 * MEASURED NECESSITY, together with the per-entry `chain` above. Without them an acceptance run read
 * **pulls 13, frames served 0, nulls 0** — every single `getFrame` still in flight after a 30-second
 * settle, with 6 live providers and a budget at 171 MB of 768 MB. Not slow: wedged. `webcodecs-decoder`
 * keeps mutable per-provider decode state (`current`, `queue`, `fed`, `lastMicros`), so two overlapping
 * `getFrame` calls on ONE provider corrupt it — the second call's seek lands mid-feed of the first
 * one's loop. `WebglMediaLayer` serializes its OWN calls, which is why the session pool still needed
 * `serializeFrameProvider` for calls from DIFFERENT owners, and this set has exactly the same exposure:
 * two MediaIns on one asset share an entry, and a remount briefly overlaps the old layer with the new.
 *
 * The raw promise is left running deliberately — it cannot be cancelled, and re-attaching to it risks
 * serving a frame from a provider that has since been disposed. The wedged provider is evicted so the
 * next pull rebuilds it, which is the same recovery an over-budget eviction already uses.
 */
function guardWedge(entry: Entry, provider: FrameProvider, raw: Promise<CanvasImageSource | null>): Promise<CanvasImageSource | null> {
  return new Promise<CanvasImageSource | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stats.wedges += 1;
      // Only if this is still the provider that wedged: a rebuild may already have replaced it.
      if (entry.provider === provider) evictProvider(entry, false);
      resolve(null);
    }, GETFRAME_WEDGE_MS);
    const finish = (frame: CanvasImageSource | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(frame);
    };
    raw.then(finish, () => finish(null));
  });
}

/**
 * The provider handed to the consumer: a stable façade over an entry whose inner provider may be
 * disposed and rebuilt underneath it.
 *
 * This is what makes I-P6's "eviction is dispose() + reconstruct" invisible to the caller. The caller
 * holds one object for the layer's life; a getFrame after an eviction rebuilds and answers, paying the
 * cold-construction cost (94-238 ms, ADR-021 §7) as latency rather than as a missing picture. A
 * consumer that had to notice eviction would need a re-acquire path, and DEBT-013 is what happens when
 * a source has to be re-admitted: it is not.
 */
function facade(entry: Entry): FrameProvider {
  return {
    get width() {
      return entry.provider?.width ?? 0;
    },
    get height() {
      return entry.provider?.height ?? 0;
    },
    get lastFrameLagSeconds() {
      return entry.provider?.lastFrameLagSeconds ?? 0;
    },
    get nominalFps() {
      return entry.provider?.nominalFps;
    },
    get decodableEndSeconds() {
      return entry.provider?.decodableEndSeconds;
    },
    async getFrame(sourceTimeSeconds: number) {
      // Stamped BEFORE the await: the pull is what makes this entry live, and a long decode must not
      // make its own source look idle to the eviction pass running underneath it.
      entry.lastPullMs = performance.now();
      entry.pulls += 1;
      stats.pulls += 1;
      if (!entry.provider) {
        if (!entry.building) {
          entry.building = buildProvider(entry).finally(() => {
            entry.building = null;
          });
          if (entry.evictions > 0) stats.rebuilds += 1;
        }
        // A "budget" outcome answers null for THIS pull and nothing more: the entry keeps its façade
        // and the next pull tries again. That is what makes budget pressure a degradation the consumer
        // rides out rather than a denial it cannot come back from.
        stats.awaitingBuild += 1;
        const rebuilt = await entry.building.finally(() => {
          stats.awaitingBuild -= 1;
        });
        if (typeof rebuilt === "string") {
          stats.buildFailures += 1;
          return null;
        }
        entry.lastPullMs = performance.now();
      }
      const provider = entry.provider;
      if (!provider) {
        stats.nulls += 1;
        return null;
      }
      // SERIALIZE, then BOUND. Both are the pool's, and omitting them cost a full acceptance run.
      const run = entry.chain.then(() => provider.getFrame(sourceTimeSeconds));
      entry.chain = run.catch(() => null);
      stats.awaitingDecode += 1;
      const frame = await guardWedge(entry, provider, run).finally(() => {
        stats.awaitingDecode -= 1;
      });
      if (frame) stats.framesServed += 1;
      else stats.nulls += 1;
      return frame;
    },
    dispose() {
      /* Lifetime belongs to the lease, not to the façade — see `release`. */
    },
  };
}

/**
 * Structurally a `PreviewFrameLease`, on purpose: the consumer (`WebglMediaLayer`) already knows how to
 * hold one, and the whole point of step 2 is that the pull path is the SAME path, differently admitted.
 * Two of the interface's members are honestly inert here and say so:
 *   `setPriority` — I-P1: a provider "holds no session, claims no slot, and has no priority". A loader
 *                   that stops mattering stops pulling, and that is the demotion (see `pickVictim`).
 *   `session.sharedWith` — always 0. Session sharing is a scarcity mechanism for a capped pool; with no
 *                   cap, two MediaIns on one asset at two times each get their own provider, which is
 *                   the correct answer to the divergence the pool had to detect and detach.
 */
export type FlarexProviderLease = PreviewFrameLease;

/**
 * Acquire a frame provider for one Flarex MediaIn source.
 *
 * **`ready` resolves null ONLY for a source that cannot be decoded at all** — a codec or container
 * `createFrameProvider` refuses — because that is the one case where the consumer's `<video>` fallback
 * is the right answer. It does **not** resolve null under budget pressure, and that asymmetry is the
 * point of the whole step: the consumer treats a null lease as terminal (`wcFallbackRef` → element
 * path, permanently), so resolving null when the set is merely full would rebuild DEBT-013 clause (a)
 * with a byte budget in place of a session cap. A source that loses the budget contest keeps its
 * façade, answers null for that pull, and is retried by the consumer's tolerant-retry loop until room
 * appears.
 *
 * NO PRIORITY ARGUMENT, deliberately (I-P1). See {@link pickVictim}: a loader that stops mattering
 * stops pulling, and that is the whole demotion signal the set needs.
 */
export function acquireFlarexSourceProvider(
  url: string,
  options: { preferSoftware?: boolean | undefined } = {}
): FlarexProviderLease {
  const software = options.preferSoftware ?? false;
  // KEYED ON THE URL ALONE, and NOT on the decode mode — the opposite of what the session pool does,
  // for a reason the pool's own comment gives: it matches mode because "a parked provider's decoder
  // cannot be reconfigured", i.e. mode is part of SLOT identity there. Here there are no slots, and
  // keying on mode instead bought a duplicate entry per source: `preferSoftwareDecode` is derived from
  // `flarexConcurrentLoaders > 1`, which flips from false to true while a comp's loaders are still
  // mounting, so the same URL was acquired first as `hw:` and then as `sw:`. Measured: **20 entries and
  // 719 MB of 768 MB charged for 12 sources**, with the budget evicting live providers to make room for
  // duplicates of themselves. An existing provider is reused as-is whatever mode it was built in.
  const key = url;
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      url,
      software,
      provider: null,
      building: null,
      chargedBytes: 0,
      lastPullMs: performance.now(),
      refCount: 0,
      evictions: 0,
      pulls: 0,
      disposed: false,
      chain: Promise.resolve(),
      releasedAtMs: 0,
    };
    entries.set(key, entry);
  }
  const target = entry;
  target.refCount += 1;
  target.disposed = false;
  target.releasedAtMs = 0;
  stats.admissions += 1;
  if (!target.building && !target.provider) {
    target.building = buildProvider(target).finally(() => {
      target.building = null;
    });
  }
  // READY RESOLVES IMMEDIATELY, before construction. The façade is valid the moment the entry exists —
  // it awaits the build inside `getFrame` — so there is nothing to wait for here, and waiting is
  // actively harmful.
  //
  // MEASURED: `WebglMediaLayer`'s watchdog treats "no element and no provider" for ~1 s as a wedged
  // init and forces the `<video>` fallback (`recordWcHeal("noSource")`). With the session pool that
  // never fired for a loader, because a denial resolved `ready` to null instantly and the layer took
  // the element path deliberately. With a byte budget a source can legitimately be a second or two from
  // its provider — queued behind admission, or waiting for room — and the watchdog read that as an
  // init hang: an acceptance run measured **noSource=12**, i.e. every loader dragged onto the element
  // path while the budget sat at 120 MB of 768 MB with zero denials. The ceiling had not moved; it had
  // been renamed.
  //
  // Handing the façade over at once puts the layer in the state its own design already handles — a
  // provider that has no frame yet — where `tolerateLag` keeps probing rather than going native
  // ("Virtual loaders never go native (16-context cap → freeze)", `requestWcFrame`'s null branch).
  //
  // Nothing is lost by not waiting for `"failed"`: `createFrameProvider` does not return null for an
  // undecodable file on the main thread — it falls back to a `<video>`-backed provider internally
  // (`source-decoder.ts`), so that outcome is reserved for a DOM-less worker, which this path is not.
  const ready: Promise<FrameProvider | null> = Promise.resolve(facade(target));
  let released = false;
  return {
    ready,
    setPriority() {
      /* I-P1: no priority. See the type's docstring. */
    },
    release() {
      if (released) return;
      released = true;
      target.refCount -= 1;
      if (target.refCount > 0) return;
      // RETAINED, not disposed — and the first version of this file got it wrong for a reason worth
      // recording. It disposed outright, arguing that "a park is a session-pool idea: it keeps a scarce
      // slot warm, and there are no slots here". The premise is right and the conclusion does not
      // follow. Retention is not about slots, it is about COLD CONSTRUCTION, which ADR-021 §7 prices at
      // 94-238 ms for proxy media and which measurement here put at seconds for un-proxied 1080p
      // originals. React remounts these layers several times while a comp settles (measured: 24
      // acquires for 6 loaders), so disposing on release meant every remount threw away a demux, a
      // sample index and a GOP window and paid for them again — an acceptance run read 22 of 25 pulls
      // ending on a build that had been torn down underneath them.
      //
      // The entry keeps its provider and STAYS CHARGED, so the budget still accounts for it honestly.
      // It simply stops being pulled, which is exactly what makes it the coldest entry and therefore
      // the first victim when room is needed. I-P6's "evict rarely" is served by keeping it; I-P6's
      // byte bound is served by it remaining on the books.
      target.releasedAtMs = performance.now();
      pruneRetained();
    },
    session: { software, sharedWith: 0 },
  };
}

/**
 * Cap how many unleased entries are kept warm.
 *
 * Retention exists to survive a REMOUNT, which is a sub-second event, not to hold every source a
 * project has ever touched. Without a cap it does: a loader's `src` changes when its ingest proxy
 * lands, so the original-URL entry is released and retained while the proxy-URL entry is created, and
 * a measured run held **19 entries for 12 sources at 669 MB of 768 MB**, evicting live providers to
 * make room for retired ones. Charged bytes are charged bytes; a warm spare that costs a live source
 * its decoder is not a saving.
 */
const MAX_RETAINED = 3;

function pruneRetained(): void {
  const retained = [...entries.entries()].filter(([, e]) => e.refCount === 0);
  if (retained.length <= MAX_RETAINED) return;
  retained.sort((a, b) => a[1].releasedAtMs - b[1].releasedAtMs);
  for (const [key, entry] of retained.slice(0, retained.length - MAX_RETAINED)) {
    entry.disposed = true;
    evictProvider(entry, false);
    entries.delete(key);
  }
}

/** Drop every provider — used when the editor tears down a project. */
export function disposeAllFlarexSourceProviders(): void {
  for (const entry of entries.values()) {
    entry.disposed = true;
    evictProvider(entry, false);
  }
  entries.clear();
  heldBytes = 0;
}
