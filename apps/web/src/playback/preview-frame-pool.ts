/**
 * WebCodecs preview decoder pool — P0 decoder pool STAGE 2 (see NLE_ANALYSIS §3a/§3e).
 *
 * Stage 1 (`lib/video-element-pool.ts`) made `<video>` decoder ELEMENTS reusable, but every visible
 * clip still holds its own hardware decode session — integrated GPUs expose only ~2–3, so a clip
 * stack silently falls back to CPU decode. Stage 2 replaces the preview's `<video>` frame source
 * with the SAME WebCodecs pipeline the export uses (`createFrameProvider` → mp4box demux +
 * VideoDecoder, seek-on-demand), under a HARD session cap:
 *
 *  - `acquirePreviewFrameProvider(url)` reserves one of {@link MAX_WC_SESSIONS} slots
 *    synchronously and inits the decoder async (`lease.ready`). Cap reached → returns null and the
 *    caller keeps today's `<video>` path — the pool can only ever LOWER the decoder count.
 *  - Released providers park in a small same-URL idle cache (warm decoder at cuts / scrub-back,
 *    the video-element pool's proven pattern); overflow is disposed for real.
 *  - Init/probe failure (unsupported codec, dead URL) resolves `ready` to null → caller falls back
 *    to `<video>`. Nothing about the caller's failure path is new: the export uses the identical
 *    provider contract with the identical fallback.
 *
 * Streaming demux (flip blocker 1, DONE): the decoder demuxes a sample INDEX from a disk-backed
 * Blob and windows encoded chunks in on demand (`webcodecs-decoder.ts`) — peak RAM is one GOP
 * window, not the whole file, on the UI thread and in the export Worker alike.
 *
 * Session SHARING (2026-07-28): a Flarex comp routinely reads one file through two doors (the host
 * clip's MediaIn and a pool-asset MediaIn pointing at the same file), and that was decoding it
 * twice — a whole slot out of four spent on a duplicate. Leases for the same decoder identity now
 * ATTACH to one session, each getting a per-consumer view that clones the frame it is handed, so
 * neither can invalidate the other's. Sharing can only ever LOWER the session count; the caps below
 * are untouched. Kill switch: `?wcShare=0`. See `plans/decoder-session-sharing.md`.
 *
 * Session prioritization (flip blocker 2): leases carry a priority — `"playhead"` (a clip the
 * viewer is actually showing) vs `"preload"` (pending/pre-roll shells warming for an upcoming
 * cut). Preload may only use a warm same-URL parked provider or a slot that leaves one free;
 * it never evicts warm parks. Playhead keeps today's behavior AND, when the pool is full of
 * preload leases, PREEMPTS the oldest one (its `onPreempted` fires → the shell falls back to the
 * `<video>` path it would have used anyway). Visibility changes flow in via `lease.setPriority`.
 *
 * Session LIFETIME ownership (2026-08-02, ADR-012 slice S3.3): this file still owns the mechanism —
 * sessions, sharing, caps, preemption, parking — but no longer owns the question *does this release
 * actually end the session?* A release now carries the kernel Decoder Manager's verdict. When a source
 * the graph still DECLARES is reading a key, the park it leaves behind is RETAINED: exempt from the
 * idle FIFO for `DECODER_RETENTION_MS`, never exempt from a cap. That is I-24 — presentation policy
 * (a component unmounting) must not decide resource lifetime. Kill switch: `?kernelDecoderLifetime=0`.
 *
 * Flag (repo convention): `?wcDecode=0|1` → localStorage `orreris.wcDecode` → `VITE_WC_DECODE` →
 * **ON** (default since 2026-07-04: long ON-flag soaks were clean, every WC failure mode self-heals
 * to the `<video>` element path, and source proxies made the decode side cheap; the flag remains
 * the kill switch). Telemetry: `window.__rfWcPool`.
 */

import { KERNEL_FLAGS, readKernelFlag } from "./kernel-flags";
import {
  DECODER_RETENTION_MS,
  kernelDiagnostics,
  defaultSession,
  noteAdmissionDenied,
  rankAdmission,
  type AdmissionCandidate,
  type VisibleContribution,
  noteBorrowGrant,
  noteBorrowRefused,
  noteSatisfactionMiss,
  sessionSatisfaction,
  noteDecoderRetentionExpired,
  noteDecoderSessionClosed,
  noteDecoderSessionOpened,
  type DecoderReleaseCause,
} from "@orreris/shared";

import { createFrameProvider, type FrameProvider } from "../export/source-decoder";
import {
  traceAliasProvider,
  traceAsset,
  traceDispose,
  traceEvent,
  traceGetFrame,
  type ProviderTraceReason,
} from "./provider-lifecycle-trace";

/** Hard cap ≈ the hardware decode sessions an integrated GPU actually has. */
const MAX_WC_SESSIONS = 3;
/**
 * Separate cap for SOFTWARE-decoded sessions (Flarex virtual loaders). Software decoders run on their
 * own CPU threads and do NOT occupy the GPU's single H.264 block, so charging them to the hardware cap
 * was a modelling error with a sharp edge: a comp with a host + 2 asset-source loaders filled all 3
 * "hardware" slots, and whichever source acquired last was refused a session and fell to the native
 * `<video>` path. Loaders are immune to that fallback (`tolerateLag`), so the loser was always the HOST
 * — the 2026-07-27 "host frozen, loaders playing" report, the exact inverse of the bug this all started
 * from. Accounting them apart lets the host keep hardware unconditionally while loaders scale on CPU.
 * Bounded (not unlimited) because each session still pins a decoder + one GOP window of RAM.
 */
const MAX_WC_SOFTWARE_SESSIONS = 3;
/**
 * TOTAL concurrent decoder sessions across BOTH modes — the real machine ceiling, and the one that
 * actually matters. Every session pins a decoder plus a GOP window of encoded samples, so the cost is
 * paid per session regardless of which engine decodes it.
 *
 * Learned the hard way (2026-07-27): splitting hardware/software into two independent caps fixed the
 * host-starvation bug but silently raised the ceiling from 3 to 3+4=7. Under rigorous scrubbing every
 * one of those decoders resets and re-buffers at once; the renderer died (white page), and once the GPU
 * process is gone the loaders can never re-acquire a provider — so `resolveSourceDraw` returns null and
 * EVERY asset-source MediaIn soft-degrades to the host clip. Two caps that merely sum are not a budget.
 */
const MAX_WC_TOTAL_SESSIONS = 4;
/**
 * Slots software leases may never occupy, so a timeline/host clip can always get a hardware session no
 * matter how many loaders a comp opens. This — not a bigger software cap — is what actually fixed the
 * host starvation; the cap split was only ever the delivery mechanism.
 */
const HARDWARE_RESERVED_SLOTS = 1;
/** Warm parked providers kept for upcoming cuts (same source). Small: each pins a decoder + buffer. */
const MAX_IDLE = 2;

export type WcLeasePriority = "playhead" | "preload";

/** Resolution order: `?wcDecode=0|1` → localStorage `orreris.wcDecode` → `VITE_WC_DECODE` → TRUE. */
export function getWcPreviewDecodeEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("wcDecode")) {
        return truthy(new URLSearchParams(window.location.search).get("wcDecode"));
      }
      const stored = window.localStorage?.getItem("orreris.wcDecode");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_WC_DECODE;
  return env == null ? true : truthy(env);
}

/**
 * Kill switch for decoder-session SHARING (below), matching the `wcDecode` convention:
 * `?wcShare=0` → localStorage `orreris.wcShare` → ON. Off restores the pre-sharing behaviour
 * exactly: one session per lease, provider handed to the consumer unwrapped.
 */
export function getWcSessionShareEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("wcShare")) {
        return truthy(new URLSearchParams(window.location.search).get("wcShare"));
      }
      const stored = window.localStorage?.getItem("orreris.wcShare");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  return true;
}

/**
 * Kill switch for kernel-owned session lifetime (ADR-012 slice S3.3), matching the `wcDecode`/`wcShare`
 * convention: `?kernelDecoderLifetime=0` → localStorage `orreris.kernel.decoderLifetime` → ON.
 *
 * OFF restores the pre-S3.3 behaviour exactly: every release parks into the same undifferentiated FIFO,
 * and a component unmount is once again the thing that ends a decoder's life. This is the programme's
 * declared rollback for the slice, and the reason it exists is R2 — decoder lifetime is the most
 * defect-dense area in the runtime, and a flag is cheaper than a revert at 2am.
 */
export function getKernelDecoderLifetimeEnabled(): boolean {
  return readKernelFlag(KERNEL_FLAGS.decoderLifetime);
}

/**
 * Kill switch for kernel-owned session SATISFACTION (ADR-012 slice S4.7):
 * `?kernelSessionSatisfaction=1` → localStorage `orreris.kernel.sessionSatisfaction` → **OFF**.
 *
 * Ships OFF, unlike S3.3's, and the asymmetry is deliberate. This is the fourth slice to touch the
 * decoder — the most defect-dense subsystem in the runtime — and programme risk R2 says never ship two
 * decoder slices in one release and soak before every merge in Phases 3–4. Off by default means the
 * merge carries zero behavioural risk while the arms are measured; the flip is a separate, evidenced
 * decision. Off restores the inherited identity-match borrow exactly.
 */
export function getKernelSessionSatisfactionEnabled(): boolean {
  return readKernelFlag(KERNEL_FLAGS.sessionSatisfaction);
}

export interface ReleaseOptions {
  /**
   * The kernel Decoder Manager's verdict (ADR-012 3.11, slice S3.3): a declared source still needs this
   * decoder, so the park it leaves behind must survive the idle FIFO for {@link DECODER_RETENTION_MS}.
   *
   * Retention never raises a cap. A retained park still counts as a live session against every ceiling
   * in this file and is still evicted when the machine budget demands it — it only changes WHICH park
   * is chosen first, which is the entire difference between "the decoder for a source that still exists"
   * and "the decoder for a clip the viewer scrolled past".
   */
  retain?: boolean | undefined;
  /** Why, for the kernel ledger. Defaults to `lifecycle` — the only cause a component release has. */
  cause?: DecoderReleaseCause | undefined;
}

export interface PreviewFrameLease {
  /** Resolves to the provider, or null when init/probe failed (caller → `<video>` fallback). */
  readonly ready: Promise<FrameProvider | null>;
  /** Idempotent. Parks a healthy provider for same-URL reuse; disposes otherwise. */
  release(options?: ReleaseOptions): void;
  /** Update pending/pre-roll ↔ live status so preemption picks the right victims. */
  setPriority(priority: WcLeasePriority): void;
  /**
   * What this lease ACTUALLY got, read live — as distinct from what it asked for.
   *
   * `__rfWcMode` / `__rfSourceMap` reported `preferSoftware` (the request), so a loader that attached
   * to the host's HARDWARE session still read `wc-sw` and a share was invisible in the one table you
   * would look at to see it. A consumer cannot know its own decode mode: it asks, the pool decides.
   */
  readonly session: {
    /** The session's REAL decoder, which may differ from `preferSoftware` when attached. */
    readonly software: boolean;
    /** Other leases on this same session right now. > 0 means this decode is being shared. */
    readonly sharedWith: number;
  };
}

export interface AcquireOptions {
  priority?: WcLeasePriority;
  /**
   * Fired (once, async-safe) when a playhead acquisition reclaims this preload lease's session.
   * The lease is already dead when this runs — the caller switches to its `<video>` fallback,
   * exactly like a mid-flight provider failure.
   */
  onPreempted?: () => void;
  /**
   * Create this provider with a SOFTWARE decoder (`hardwareAcceleration: "prefer-software"`). Used by
   * Flarex virtual loaders: the GPU's single H.264 block can't feed ~3 concurrent seek-on-demand streams,
   * so the non-primary ones starve/freeze. Software-decoded sources run on their own CPU thread, off the
   * contended hardware block (and still off-DOM — no `<video>` 16-context cap), so the host keeps hardware
   * and the loaders advance in parallel. Warm same-URL reuse ignores this (a parked provider is taken as-is).
   */
  preferSoftware?: boolean | undefined;
  /**
   * This consumer reads the URL at a time NOTHING ELSE will ask for, so it must never share a session
   * — neither by joining one nor by being joined.
   *
   * Sharing is only ever a win when the members want the SAME time: they await one `pending` promise or
   * hit `lastServed`. Two members at different times each force a fresh `getFrame` on one decoder,
   * which for far-apart timestamps is a seek (a whole GOP) per member per frame. `noteDivergence`
   * already detects that and detaches the later joiner — but only after `SHARE_DIVERGENCE_STRIKES`
   * frames of it, and it pays that toll again every time the session is rebuilt (seek, preempt,
   * quality change), which under scrubbing is constantly.
   *
   * Set by a RETIMED Flarex loader (TimeSpeed, ADR-011), where the divergence is not a runtime
   * accident to be discovered but a fact known before the first frame: a 0.5× loader of the host's own
   * file is asking for `t/2` precisely because the host is asking for `t`. Declaring it skips the
   * discovery entirely. Un-retimed loaders still share with their host, which is the whole point of
   * v32l and stays untouched.
   */
  exclusive?: boolean | undefined;
  /**
   * The source time this consumer is about to ask for — **declared intent** (ADR-012 slice S4.7).
   *
   * The 2026-08-02 S3.3 audit found the hole this fills: at the instant a borrow was granted the
   * joining member had not asked for anything. `SharedMember.requestedTime` is NaN until the first
   * `getFrame`, and nothing else here carried a time — so the pool decided sharing strictly BEFORE it
   * could know whether the two members' times co-locate. Identity-alone was not merely the unguarded
   * choice, it was the only decision the interface could express.
   *
   * Optional because a caller that genuinely cannot say must be able to say *that*. It is not a
   * loophole: an undeclared joiner is REFUSED a borrow (`joiner-undeclared`), so a missed call site
   * shows up as a lost share rather than as a silently resurrected defect. Ignored entirely when the
   * satisfaction flag is off.
   */
  requestedTime?: number | undefined;
  /**
   * What this consumer contributes to the picture — **declared merit** (ADR-012 §6.3, slice S4.3).
   *
   * Admission ranks by visible contribution rather than by arrival, because arrival is a React
   * scheduling artifact: whichever MediaIn mounts first wins a hardware slot today, so which source
   * looks broken can differ between two runs of one project.
   *
   * Optional for the same reason `requestedTime` is, and with the OPPOSITE default. An undeclared
   * borrow is refused (a lost share is cheap and visible); an undeclared *admission* is ranked at
   * {@link UNDECLARED_RANK} — above provably-invisible, below provably-visible — because refusing here
   * would deny a decoder outright and turn a missing call site into a black picture.
   *
   * NOTE what must NOT be passed as zero contribution: a `hidden` pre-roll shell (it is about to be on
   * screen and denying it defeats pre-roll) and a `suspended`/demoted source (I-24 — a presentation
   * policy must not change resource lifetime; demotion suspends the PULL, never the session).
   */
  contribution?: VisibleContribution | undefined;
}

interface IdleEntry {
  url: string;
  provider: FrameProvider;
  /** Which decoder this provider actually IS. Warm reuse must match it — see `acquire`. */
  software: boolean;
  /**
   * `performance.now()` deadline until which this park is RETAINED (0 = an ordinary park).
   *
   * Set only when the kernel Decoder Manager overruled a lifecycle release (S3.3). Bounded on purpose:
   * a source can stay declared forever while the viewer never looks at it again, and an unbounded
   * retention would be a leak wearing the costume of a fix (I-31).
   */
  retainUntil: number;
}

interface LeaseRecord {
  url: string;
  priority: WcLeasePriority;
  acquiredAt: number;
  software: boolean;
  /**
   * What this lease declared it contributes to the picture (S4.3). Absent when the producer could not
   * say — see {@link AcquireOptions.contribution}; absent is NOT zero, and the kernel ranks it as
   * undeclared rather than as worthless.
   */
  contribution?: VisibleContribution | undefined;
  preempt(): void;
}

let activeSessions = 0;
let activeSoftwareSessions = 0;
const idle: IdleEntry[] = [];
const activeLeases = new Set<LeaseRecord>();
let reused = 0;
let created = 0;
let createdSoftware = 0;
let capMisses = 0;
/**
 * Denials RANKED and recorded (S4.3). Read beside `capMisses`, never instead of it: `capMisses` counts
 * the times a caller fell back, this counts the times the kernel could say who should have lost. They
 * differ while producers have not all declared a contribution, and that difference is the wiring gap.
 */
let admissionDenialCount = 0;
let initFailures = 0;
let preemptions = 0;
let shared = 0;
let shareDetaches = 0;
/**
 * Borrows the S4.7 predicate declined. The COST side of the slice: each one spends a session out of a
 * budget of four, so a rising count with no corresponding fall in `shareDetaches` is the too-strict
 * predicate this slice lists as its own risk.
 */
let borrowRefusals = 0;
let wedgeTimeouts = 0;
let retentions = 0;
let retentionHits = 0;
let retentionExpiries = 0;
let retentionOverrides = 0;

/**
 * BACKSTOP for a `getFrame` that never settles (2026-07-28).
 *
 * Every other bound in this path sits ABOVE the decode and cannot interrupt it:
 * `WC_INIT_TIMEOUT_MS` 4000 covers init, `WC_BUSY_WEDGE_MS` 3000 DETECTS a stuck call, the catch-up
 * hold caps at `WC_HOLD_MAX_MS` 5000, and the decoder's own flush races a 5s timeout. None of them can
 * end a decode already in flight. `serializeFrameProvider` then chains every later call behind it, so
 * one non-settling promise blocks the provider forever — and the `busyWedge` heal cannot recover it,
 * because the re-request it issues queues behind the very call that is stuck. The heal counter
 * increments, the layer clears its busy flag, and the picture stays dead: a freeze that reports itself
 * as handled.
 *
 * v32l widened the blast radius. Members of a shared session await the SAME `session.pending` promise,
 * so one wedged decode now takes the host clip and the Flarex loader together — the whole comp rather
 * than one node. That cost was not accounted for when sharing shipped.
 *
 * 10s, deliberately far above every bound listed above: this must fire only when all of them have
 * already had their chance and failed. It is a last resort, not a latency control — a slow decode is
 * the layer-level wedge heal's business, and a >3s decode that later recovered has been observed in
 * the wild. Firing this on merely-slow media would tear down healthy sessions to fix nothing.
 */
let getFrameWedgeTimeoutMs = 10_000;

/**
 * TEST SEAM (`wcpool:test`). The gate has to prove the backstop fires and that the session recovers,
 * and it cannot spend 10s per assertion doing it. Passing null restores the production value.
 */
export function __setWedgeTimeoutForTests(ms: number | null): void {
  getFrameWedgeTimeoutMs = ms ?? 10_000;
}

/**
 * Bound one decode. Resolves `null` at the deadline — never rejects, because every caller already
 * handles a null frame (that is the decoder-bailed path) and a rejection here would surface as an
 * unhandled error in the rAF loop.
 *
 * On timeout the session is torn down as a PREEMPTION, reusing the one teardown that already gets
 * ordering right (notify-then-dispose, every member's `onPreempted` before the provider dies). A
 * decoder that has not answered in 10s is not slow, it is broken; parking it warm for reuse would
 * hand the next lease the same wedged decoder. Members fall back or re-acquire and get a fresh one.
 *
 * The raw promise is deliberately left running. It cannot be cancelled, and attaching to it after the
 * fact only risks resolving a frame from a decoder that has since been disposed — which the member
 * path already guards with its `session.provider !== provider` identity check.
 */
function guardWedge(session: SharedSession, raw: Promise<CanvasImageSource | null>): Promise<CanvasImageSource | null> {
  return new Promise<CanvasImageSource | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      wedgeTimeouts += 1;
      try {
        // `failed`, not `preempted`: the mode is a preemption because that is the teardown that gets
        // the ordering right, but the CAUSE is a decoder that stopped answering. Conflating them would
        // make the ledger read slot pressure where there was a broken decode.
        tearDownSession(session, "preempt", { cause: "failed" });
      } catch {
        /* teardown must never turn a stalled frame into a thrown one */
      }
      resolve(null);
    }, getFrameWedgeTimeoutMs);
    const finish = (frame: CanvasImageSource | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(frame);
    };
    raw.then(finish, () => finish(null));
  });
}
let sharedFramesServed = 0;
let sharedFrameHits = 0;

/**
 * Serialize getFrame across lease owners. release() parks a provider immediately, so a newly
 * mounting layer can warm-reuse it while the OLD owner's getFrame is still awaiting inside the
 * decoder loop — the new call's backward-jump reset() then lands mid-feed of the old loop and the
 * decoder throws "a key frame is required" (seen in the 2026-07-03 soak). Each layer already
 * serializes its OWN calls; this chain serializes across owners of the same pooled provider.
 */
function serializeFrameProvider(provider: FrameProvider, traceUrl = ""): FrameProvider {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    get width() {
      return provider.width;
    },
    get height() {
      return provider.height;
    },
    getFrame(sourceTimeSeconds: number) {
      // TRACE ONLY: brackets the call so the trace knows what is in flight on this provider when it is
      // disposed, and whether a call resolved after its decoder was closed. `done()` is a no-op when
      // the flag is off, and the returned promise is untouched either way.
      const done = traceGetFrame(provider, traceAsset(traceUrl), sourceTimeSeconds);
      const run = chain.then(() => provider.getFrame(sourceTimeSeconds));
      chain = run.catch(() => null);
      void run.then(done, done);
      return run;
    },
    // MUST forward: the presenter's catch-up hold reads this after every getFrame. This wrapper
    // silently dropping it made `lag` always 0 — the hold NEVER engaged, and the rewind/seek
    // fast-forward pan survived three fix attempts (2026-07-04). Any new FrameProvider field
    // needs forwarding here or the preview pool erases it.
    get lastFrameLagSeconds() {
      return provider.lastFrameLagSeconds ?? 0;
    },
    // Same rule (2026-07-28): the temporal-coherence gate divides `lastFrameLagSeconds` into the
    // part that is normal frame quantization and the part that is real staleness, and it needs the
    // source's frame PERIOD to do it. Erased here, every source would look stale by up to a frame
    // and the paused present gate would hold on correctly-served media.
    get nominalFps() {
      return provider.nominalFps;
    },
    get decodableEndSeconds() {
      return provider.decodableEndSeconds;
    },
    dispose() {
      provider.dispose();
    },
  };
}

/** Trace-only wrapper: records WHY a decoder is being closed and whether work was still in flight. */
function disposeTraced(provider: FrameProvider, url: string, reason: ProviderTraceReason) {
  traceDispose(provider, traceAsset(url), reason);
  disposeQuietly(provider);
}

function disposeQuietly(provider: FrameProvider) {
  try {
    provider.dispose();
  } catch {
    /* a dying decoder must never throw into UI code */
  }
}

/**
 * Pick a parked provider to warm-reuse, or -1. PURE (exported for `wcpool:test`) — the whole bug this
 * guards is a one-character-class mistake in this predicate, and it is not observable from any pool
 * statistic: a mode-mismatched reuse looks like a perfectly healthy cache HIT.
 *
 * Matching the URL alone is NOT sufficient. See the acquire path for the failure it caused.
 */
export function findWarmIdleIndex(
  entries: readonly { url: string; software: boolean }[],
  url: string,
  software: boolean
): number {
  return entries.findIndex((entry) => entry.url === url && entry.software === software);
}

// ── Retained parks (slice S3.3) ─────────────────────────────────────────────
//
// A retained park is an ordinary park with a deadline and a preference. It changes exactly one thing:
// the ORDER in which parks are chosen for eviction. Every cap in this file still binds.

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Drop expired retentions back to ordinary parks, reporting each expiry (I-31 — a bounded wait whose
 * expiry is never reported is indistinguishable from one that always paid off).
 *
 * Called from the two paths that can consume a park, so an expired retention can never be honoured:
 * expiring lazily rather than on a timer keeps this file free of a scheduler it does not need, and a
 * retention nobody ever looks at costs nothing to have held a moment too long.
 */
function expireRetentions(at: number): void {
  for (const entry of idle) {
    if (entry.retainUntil === 0 || entry.retainUntil > at) continue;
    entry.retainUntil = 0;
    retentionExpiries += 1;
    noteDecoderRetentionExpired(defaultSession, entry.url);
  }
}

/**
 * Index of the park to evict among those matching `match`, preferring one that is NOT retained.
 *
 * Falls back to a retained park when every candidate is retained: retention is a preference, never a
 * veto. A budget a subsystem can refuse to honour is not a budget, and this file already carries the
 * scar from two caps that "merely summed" (see `MAX_WC_TOTAL_SESSIONS`).
 */
function pickEvictIndex(match: (entry: IdleEntry) => boolean): number {
  expireRetentions(nowMs());
  const free = idle.findIndex((entry) => match(entry) && entry.retainUntil === 0);
  if (free !== -1) return free;
  const retained = idle.findIndex(match);
  if (retained !== -1) retentionOverrides += 1;
  return retained;
}

// ── Shared decoder sessions ─────────────────────────────────────────────────
//
// THE INVARIANT, stated once and relied on everywhere below:
//
//   *** Exactly one SharedSession owns a FrameProvider. Every lease merely LEASES access. ***
//
// Disposal, session accounting (`bumpActive`), parking and preemption are the owner's business
// alone. A lease may close only the clones it made. Every rule in this section is a consequence.
//
// WHY IT EXISTS. A Flarex comp can read one file through two doors — the host clip's MediaIn (empty
// `sourceAssetId`) and a pool-asset MediaIn pointing at the same file. Confirmed live 2026-07-28:
// asset `65ff9c00` decoded twice (`wc-hw` host + `wc-sw` loader) and those two were the ONLY stale
// sources in the comp, while the sources that owned their asset sat at staleness 0. Nothing showed
// up as a cap miss (`capMisses: 0`) because four consumers fit a 4-slot budget EXACTLY — there was
// simply no headroom, and one of the four slots was pure duplication.

/** Frames of skew two consumers may request before the share is considered broken. */
const SHARE_DIVERGENCE_FRAMES = 2;
/** Consecutive diverged frames before the later-joined lease is detached. Hysteresis: one stray
 *  sample during a seek must never split a healthy share. */
const SHARE_DIVERGENCE_STRIKES = 4;

/**
 * May a consumer wanting `wantSoftware` attach to a session that IS `sessionSoftware`? PURE
 * (exported for `wcpool:test`) — this one function is the entire 2026-07-27 guarantee, which is why
 * it is asserted directly rather than left buried in `acquire`.
 *
 * The asymmetry is the whole design. That rule exists because N sessions contend for one hardware
 * block; a single SHARED session is not contention, it is one decode feeding two consumers. So a
 * HARDWARE session accepts anyone (total sessions drop by one, everybody gets hardware frames),
 * while a SOFTWARE session accepts only a consumer that ASKED for software — a lag-intolerant
 * consumer can never be handed a software decode it did not request. That was the bug; it stays fixed.
 */
export function canAttachToSession(sessionSoftware: boolean, wantSoftware: boolean): boolean {
  return sessionSoftware === false || wantSoftware === true;
}

/**
 * Divergence tolerance in SECONDS, derived from a FRAME count. PURE (exported for `wcpool:test`).
 *
 * A fixed millisecond budget would be ~2.4 frames at 24fps and ~12 at 120fps — strict on one source
 * and meaningless on another, while the question being asked ("are these two consumers on the same
 * picture?") is inherently a frame-count question. Same reasoning that made
 * `PROXY_KEYFRAME_EVERY_N_FRAMES` a frame count after 1-second GOPs froze 60fps proxies. The `|| 30`
 * covers providers that cannot report a rate.
 */
export function divergenceToleranceSeconds(nominalFps?: number | undefined): number {
  return SHARE_DIVERGENCE_FRAMES / (nominalFps && nominalFps > 0 ? nominalFps : 30);
}

/** True when the spread of requested times exceeds the tolerance. PURE (exported for `wcpool:test`). */
export function isDiverged(requestedTimes: readonly number[], nominalFps?: number | undefined): boolean {
  if (requestedTimes.length < 2) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const t of requestedTimes) {
    // A member that has never asked for a frame cannot diverge from anything.
    if (!Number.isFinite(t)) return false;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return max - min > divergenceToleranceSeconds(nominalFps);
}

interface SharedMember {
  priority: WcLeasePriority;
  /**
   * Monotonic JOIN ORDER, deliberately not a `Date.now()` timestamp. Two layers mounting in the
   * same tick attach in the same millisecond, so a clock ties — and the divergence detach picks the
   * later joiner by this field. Under a tie it picked whichever the Set iterated first, which is the
   * HOST: the exact "detach the wrong one" inversion this whole file keeps relearning.
   */
  joinedAt: number;
  /** Last time this lease asked for, for divergence. NaN until its first `getFrame`. */
  requestedTime: number;
  strikes: number;
  /** THIS lease's outstanding clone — the only frame it is allowed to close. */
  held: CanvasImageSource | null;
  dead: boolean;
  onPreempted?: (() => void) | undefined;
}

interface SharedSession {
  /**
   * DECODER IDENTITY — not merely a URL.
   *
   * Today a decoder is fully described by its URL, so the key IS the url. It is named `key` rather
   * than `url` because that equivalence is a property of today's `createFrameProvider` options, not
   * a law: the moment a consumer can ask for a different colour space, alpha mode, bit depth or
   * rotation handling, two consumers of one URL stop being interchangeable and this key must grow to
   * include those. Sharing incompatible sessions would be silent and would look like a cache hit.
   */
  key: string;
  /** What the session ACTUALLY is, not what any member asked for. */
  software: boolean;
  /** Null while initializing and after teardown. The owned provider — see the invariant. */
  provider: FrameProvider | null;
  ready: Promise<FrameProvider | null>;
  refCount: number;
  members: Set<SharedMember>;
  /**
   * DUPLICATE-CALL ELIMINATOR — NOT a frame cache. Exactly one entry, deliberately.
   *
   * Its only job is to collapse two consumers asking for the SAME timestamp in the same frame into
   * one decode. It must never grow into a seek cache: every retained entry pins a `VideoFrame`,
   * which is a hard-limited resource, and a decoder starved of frame slots stalls outright. Real
   * caching would be a different mechanism with a different budget — not this field with a bigger
   * number.
   */
  lastServed: { time: number; frame: CanvasImageSource | null } | null;
  /** In-flight equivalent of `lastServed`: the common case is two layers requesting the same
   *  timestamp in one rAF tick, BOTH before either resolves. Without this the memo never hits and
   *  the share saves a session but not a single decode. */
  pending: { time: number; promise: Promise<CanvasImageSource | null> } | null;
  /** Cleared for good after a divergence detach, so the detached consumer cannot re-attach to the
   *  session it just split from and oscillate. */
  shareable: boolean;
  torn: null | "release" | "preempt";
  record: LeaseRecord;
}

const sharedSessions = new Set<SharedSession>();
let memberJoinSeq = 0;

/**
 * TEST SEAM (`wcpool:test`), not referenced by app code. Node has neither WebCodecs nor a real file
 * to demux, so the gate this design most needs — two acquisitions in ONE tick must produce exactly
 * ONE provider — cannot be run against the real decoder. Passing null restores the real factory.
 */
let frameProviderFactory: typeof createFrameProvider = createFrameProvider;
export function __setFrameProviderFactoryForTests(factory: typeof createFrameProvider | null): void {
  frameProviderFactory = factory ?? createFrameProvider;
}

function isVideoFrame(frame: CanvasImageSource | null): boolean {
  return frame != null && typeof VideoFrame !== "undefined" && frame instanceof VideoFrame;
}

/** Refcounted handle, no pixel copy — the same trick `WebglMediaLayer.setWcHeldFrame` already uses.
 *  Non-`VideoFrame` sources (element/canvas/ImageBitmap fallbacks) are not consumed by drawing and
 *  pass through untouched. */
function cloneForConsumer(frame: CanvasImageSource | null): CanvasImageSource | null {
  if (!isVideoFrame(frame)) return frame;
  try {
    return (frame as VideoFrame).clone();
  } catch {
    return frame;
  }
}

function releaseMemberClone(member: SharedMember): void {
  const held = member.held;
  member.held = null;
  if (!isVideoFrame(held)) return;
  try {
    (held as VideoFrame).close();
  } catch {
    /* a dying frame must never throw into UI code */
  }
}

function recomputeSessionPriority(session: SharedSession): void {
  let priority: WcLeasePriority = "preload";
  for (const member of session.members) {
    if (member.priority === "playhead") {
      priority = "playhead";
      break;
    }
  }
  session.record.priority = priority;
}

/**
 * Candidates by IDENTITY. Unchanged from before S4.7 and deliberately still identity-only: this answers
 * "which sessions COULD serve this key at all", which is a compatibility question about decoders.
 * Whether one of them SHOULD is a different question with a different owner — see `chooseSatisfying`.
 */
function findAttachableSession(key: string, software: boolean): SharedSession | null {
  for (const session of sharedSessions) {
    if (session.torn || !session.shareable) continue;
    if (session.key !== key) continue;
    if (!canAttachToSession(session.software, software)) continue;
    return session;
  }
  return null;
}

/**
 * S4.7: of the identity-compatible sessions, pick one that can serve `requestedTime` **without
 * degrading the service it already provides** — or none, and say why.
 *
 * Split from `findAttachableSession` rather than folded into it because the two questions are owned by
 * different subsystems: identity/decode-mode compatibility is a property of decoders (this file),
 * satisfaction is ADR-012 §3.11's (the kernel). Folding them would have hidden a policy decision inside
 * a lookup, which is the shape of defect this whole programme exists to unwind.
 *
 * The tolerance handed to the kernel is `divergenceToleranceSeconds` — the SAME number `isDiverged`
 * uses on the live share. That is what makes the slice's *done when* meaningful: the predicate refuses
 * exactly what the backstop would later detach, so a `noteDivergence` firing is a proof the predicate
 * was wrong rather than a routine correction (programme §10).
 */
function chooseSatisfyingSession(
  key: string,
  software: boolean,
  options: AcquireOptions,
  priority: WcLeasePriority
): SharedSession | null {
  const candidate = findAttachableSession(key, software);
  if (!candidate) return null;
  if (!getKernelSessionSatisfactionEnabled()) return candidate; // flag off → inherited identity-match

  const incumbentTimes: number[] = [];
  for (const member of candidate.members) incumbentTimes.push(member.requestedTime);
  const verdict = sessionSatisfaction(
    incumbentTimes,
    options.requestedTime ?? null,
    divergenceToleranceSeconds(candidate.provider?.nominalFps)
  );
  if (verdict.satisfies) return candidate;
  borrowRefusals += 1;
  noteBorrowRefused(defaultSession, {
    key,
    verdict,
    joinerPriority: priority,
    incumbentPriority: candidate.record.priority,
  });
  // No fall-through to another candidate: `findAttachableSession` returns the first compatible session
  // and there is at most one live session per key by construction (a second is only created when this
  // path declines). Scanning further would be dead code pretending to be thorough.
  return null;
}

/**
 * End a session and free its slot. `mode` decides the provider's fate exactly as the pre-sharing
 * code did: a preemption must actually free the decoder NOW (dispose), a release may park it warm.
 *
 * ORDERING IS PART OF THE CONTRACT: on preemption every member's callback fires BEFORE the shared
 * provider is disposed. Notify-then-dispose, never dispose-then-notify — a member reacting
 * synchronously (switching to `<video>`, clearing a held frame) must never be able to observe a
 * half-torn session, and disposing first would make that ordering an accident of implementation.
 */
/**
 * `cause` and `retain` are the kernel ledger's inputs (S3.3). They live on THIS function rather than on
 * `release()` because this is the one place a session actually ends — via a release, a preemption, a
 * wedge write-off or a failed init. Recording the close at the caller instead would have missed three
 * of those four, and a ledger that only sees the tidy path is worse than no ledger.
 */
function tearDownSession(
  session: SharedSession,
  mode: "release" | "preempt",
  options: { retain?: boolean; cause?: DecoderReleaseCause } = {}
): void {
  if (session.torn) return;
  const retain = options.retain === true;
  noteDecoderSessionClosed(defaultSession, session.key, options.cause ?? (mode === "preempt" ? "preempted" : "lifecycle"));
  session.torn = mode;
  session.shareable = false;
  sharedSessions.delete(session);
  activeLeases.delete(session.record);
  bumpActive(session.software, -1);

  if (mode === "preempt") {
    for (const member of session.members) {
      member.dead = true;
      try {
        member.onPreempted?.();
      } catch {
        /* victim callback must not break the acquiring path */
      }
    }
  }
  for (const member of session.members) {
    member.dead = true;
    releaseMemberClone(member);
  }
  session.members.clear();
  session.refCount = 0;

  const provider = session.provider;
  session.provider = null;
  session.lastServed = null;
  session.pending = null;
  if (!provider) return; // still initializing — the init `.then` reads `session.torn` and finishes the job
  if (mode === "preempt") disposeTraced(provider, session.key, "preempt");
  else parkOrDispose(session.key, provider, session.software, retain);
}

/**
 * `retain` is the kernel's verdict and it only reaches the park when this member was the LAST one.
 * While another lease is still on the session there is nothing to retain: the decoder is not going
 * anywhere, and marking a live session retained would double-count it against the retention budget.
 */
function releaseMember(
  session: SharedSession,
  member: SharedMember,
  options: { retain?: boolean; cause?: DecoderReleaseCause } = {}
): void {
  if (member.dead) return;
  member.dead = true;
  releaseMemberClone(member);
  session.members.delete(member);
  session.refCount -= 1;
  if (session.refCount <= 0) tearDownSession(session, "release", options);
  else recomputeSessionPriority(session);
}

/**
 * Two decoders thrash far less than one decoder dragged between two playheads, so a share must be
 * able to give up. When the members' requested times stay apart for `SHARE_DIVERGENCE_STRIKES`
 * consecutive frames, detach the LATER-joined one: it is notified exactly like a preemption and
 * re-acquires its own session (or falls back to `<video>` if the pool is full — the same path it
 * takes today when refused).
 */
function noteDivergence(session: SharedSession): void {
  if (session.members.size < 2) return;
  const times: number[] = [];
  for (const member of session.members) times.push(member.requestedTime);
  if (!isDiverged(times, session.provider?.nominalFps)) {
    for (const member of session.members) member.strikes = 0;
    return;
  }
  let latest: SharedMember | null = null;
  for (const member of session.members) {
    if (!latest || member.joinedAt > latest.joinedAt) latest = member;
  }
  if (!latest) return;
  latest.strikes += 1;
  if (latest.strikes < SHARE_DIVERGENCE_STRIKES) return;

  shareDetaches += 1;
  // S4.7 (programme §10 — repair becomes diagnostics). This detach is still the repair, and it stays:
  // a backstop that was removed would take its evidence with it. But with the flag on it also carries a
  // second meaning — the kernel APPROVED this share, using the very tolerance `isDiverged` just failed,
  // so a firing is a defect report against `sessionSatisfaction` rather than a routine correction. The
  // slice's *done when* is that this number stays at zero across a full soak.
  if (getKernelSessionSatisfactionEnabled()) {
    noteSatisfactionMiss(defaultSession, session.key, {
      requestedTimes: times.filter((time) => Number.isFinite(time)),
      toleranceSeconds: divergenceToleranceSeconds(session.provider?.nominalFps),
      members: session.members.size,
      strikes: latest.strikes,
    });
  }
  session.shareable = false;
  const notify = latest.onPreempted;
  releaseMember(session, latest);
  try {
    notify?.();
  } catch {
    /* victim callback must not break the serving path */
  }
}

/**
 * The per-consumer view of a shared provider. Reproduces the documented `FrameProvider` contract —
 * "provider-owned, valid until the next call/dispose" — PER LEASE rather than per provider, so
 * consumer B's call can never invalidate the frame consumer A is still holding. That silent
 * cross-invalidation is the failure mode that would make this whole change look fine and corrupt
 * playback intermittently.
 */
function memberProvider(session: SharedSession, member: SharedMember): FrameProvider {
  return {
    get width() {
      return session.provider?.width ?? 0;
    },
    get height() {
      return session.provider?.height ?? 0;
    },
    async getFrame(sourceTimeSeconds: number): Promise<CanvasImageSource | null> {
      const provider = session.provider;
      if (!provider || member.dead) return null;
      member.requestedTime = sourceTimeSeconds;
      const counts = session.refCount > 1; // only a REAL share tells us anything about sharing
      if (counts) sharedFramesServed += 1;
      const halfPeriod = 0.5 / (provider.nominalFps && provider.nominalFps > 0 ? provider.nominalFps : 30);

      let frame: CanvasImageSource | null;
      const pending = session.pending;
      const memo = session.lastServed;
      if (pending && Math.abs(pending.time - sourceTimeSeconds) < halfPeriod) {
        if (counts) sharedFrameHits += 1;
        frame = await pending.promise;
      } else if (memo && Math.abs(memo.time - sourceTimeSeconds) < halfPeriod) {
        if (counts) sharedFrameHits += 1;
        frame = memo.frame;
      } else {
        // The GUARDED promise is what goes in `pending`, not the raw one: a second member that hits
        // the pending path awaits this same object, so bounding it here bounds every sharer at once.
        // Storing the raw promise would leave joiners hanging on a call the owner had already given
        // up on — the one member protected, the rest wedged, which is worse than nobody protected
        // because the pool would look healthy.
        const run = guardWedge(session, provider.getFrame(sourceTimeSeconds));
        session.pending = { time: sourceTimeSeconds, promise: run };
        frame = await run;
        if (session.pending?.promise === run) session.pending = null;
        if (session.provider === provider) session.lastServed = { time: sourceTimeSeconds, frame };
      }
      // Torn down (or superseded) while we awaited: the frame we are holding belongs to a decoder
      // that no longer exists. Never hand it out.
      if (member.dead || session.provider !== provider) return null;

      releaseMemberClone(member);
      member.held = cloneForConsumer(frame);
      noteDivergence(session);
      return member.held;
    },
    // MUST forward, all three — the file already warns twice that a wrapper dropping a field is a
    // silent, expensive bug (`lastFrameLagSeconds` made the catch-up hold never engage;
    // `nominalFps` would make every source read stale to the coherence gate).
    get lastFrameLagSeconds() {
      return session.provider?.lastFrameLagSeconds ?? 0;
    },
    get nominalFps() {
      return session.provider?.nominalFps;
    },
    get decodableEndSeconds() {
      return session.provider?.decodableEndSeconds;
    },
    /** Closes only THIS lease's clone. Disposing the shared provider is the session's business. */
    dispose() {
      releaseMemberClone(member);
    },
  };
}

function attachMember(session: SharedSession, options: AcquireOptions): PreviewFrameLease {
  const member: SharedMember = {
    priority: options.priority ?? "playhead",
    joinedAt: (memberJoinSeq += 1),
    requestedTime: Number.NaN,
    strikes: 0,
    held: null,
    dead: false,
    onPreempted: options.onPreempted,
  };
  session.members.add(member);
  session.refCount += 1;
  recomputeSessionPriority(session);

  const wrap = getWcSessionShareEnabled();
  const ready = session.ready.then((provider) => {
    if (!provider || member.dead) return null;
    // Flag OFF: hand back the serialized provider unwrapped — byte-identical to pre-sharing.
    return wrap ? memberProvider(session, member) : provider;
  });

  const view = {
    get software() {
      return session.software;
    },
    get sharedWith() {
      // Read live: the host acquires FIRST and is alone at that instant — a value snapshotted at
      // mount would report "not shared" for the very lease that ends up sharing.
      return member.dead ? 0 : Math.max(0, session.refCount - 1);
    },
  };

  return {
    ready,
    session: view,
    release(options?: ReleaseOptions) {
      if (member.dead) return;
      traceEvent({ event: "release", provider: session.provider, asset: traceAsset(session.key), reason: "explicit" });
      releaseMember(session, member, {
        retain: options?.retain === true && getKernelDecoderLifetimeEnabled(),
        cause: options?.cause ?? "lifecycle",
      });
    },
    setPriority(next: WcLeasePriority) {
      member.priority = next;
      if (!member.dead) recomputeSessionPriority(session);
    },
  };
}

function createSession(
  key: string,
  software: boolean,
  priority: WcLeasePriority,
  warm: FrameProvider | null,
  contribution?: VisibleContribution | undefined
): SharedSession {
  // `record.preempt` and the init `.then` both close over `session`, so those two fields can only be
  // assigned after the object exists. The cast buys that one cycle and nothing else.
  const session = {
    key,
    software,
    provider: warm,
    refCount: 0,
    members: new Set<SharedMember>(),
    lastServed: null,
    pending: null,
    shareable: true,
    torn: null,
  } as unknown as SharedSession;

  session.record = {
    url: key,
    priority,
    acquiredAt: Date.now(),
    software,
    // Carried so a LATER cap miss can rank this incumbent against the newcomer. Admission compares a
    // request against the sessions actually held, and an incumbent whose merit was thrown away at
    // acquire time can only ever be ranked as undeclared.
    contribution,
    preempt() {
      if (session.torn) return;
      preemptions += 1;
      tearDownSession(session, "preempt");
    },
  };
  activeLeases.add(session.record);
  sharedSessions.add(session);

  session.ready = warm
    ? Promise.resolve(warm)
    : // frameBudgetMs: preview must never block a frame request for seconds while a sparse-keyframe
      // source catches up after a rewind — return the stale frame and continue next call. The export
      // creates its providers WITHOUT a budget and keeps blocking-until-decoded semantics.
      frameProviderFactory(key, "video", { frameBudgetMs: 24, preferSoftware: software })
        .then((raw) => {
          const provider = serializeFrameProvider(raw, key);
          traceAliasProvider(raw, provider);
          created += 1;
          traceEvent({ event: "create", provider, asset: traceAsset(key), reason: "explicit", note: `software=${software}` });
          if (software) createdSoftware += 1;
          if (session.torn === "preempt") {
            // Preempted while initializing — the session is already re-spent; drop the decoder.
            disposeTraced(provider, key, "preempt-during-init");
            return null;
          }
          if (session.torn === "release") {
            // Every member released while initializing — park it warm instead of wasting the work.
            traceEvent({ event: "release", provider, asset: traceAsset(key), reason: "released-during-init" });
            parkOrDispose(key, provider, software);
            return null;
          }
          session.provider = provider;
          return provider;
        })
        .catch(() => {
          initFailures += 1;
          traceEvent({ event: "create", asset: traceAsset(key), reason: "init-failed" });
          // Unwinds the accounting and evicts the session from the registry, so nothing can attach
          // to a decoder that never existed. `provider` is null, so nothing is parked or disposed.
          tearDownSession(session, "release", { cause: "failed" });
          return null;
        });

  return session;
}

// ── Per-decode-mode session accounting ──────────────────────────────────────
// Hardware and software decoders draw on DIFFERENT physical resources (the GPU's video block vs CPU
// threads), so they get their own caps, their own idle pools and their own preemption victims. A
// software lease must never be able to starve or preempt a hardware one.
/** Per-mode ceiling. Software is additionally held below the total so the host keeps a reserved slot. */
export const sessionCap = (software: boolean): number =>
  software ? Math.min(MAX_WC_SOFTWARE_SESSIONS, MAX_WC_TOTAL_SESSIONS - HARDWARE_RESERVED_SLOTS) : MAX_WC_SESSIONS;
const activeOf = (software: boolean): number => (software ? activeSoftwareSessions : activeSessions);
/** Every real decoder session alive right now — active in BOTH modes plus idle parks (which pin one). */
const totalSessions = (): number => activeSessions + activeSoftwareSessions + idle.length;
const idleCountOf = (software: boolean): number => idle.reduce((n, entry) => n + (entry.software === software ? 1 : 0), 0);
function bumpActive(software: boolean, delta: number): void {
  if (software) activeSoftwareSessions = Math.max(0, activeSoftwareSessions + delta);
  else activeSessions = Math.max(0, activeSessions + delta);
}

/**
 * Claim one decoder slot for `software` at `priority`, freeing what it can. False = genuinely full
 * (the caller falls back to a native `<video>`). Enforces TWO ceilings, and both are load-bearing:
 *
 *   1. the per-mode cap — so software loaders can never occupy the host's reserved hardware slot;
 *   2. the TOTAL cap — the machine's real limit. Skipping this is what let the mode split quietly
 *      raise concurrency 3 → 7 and crash the renderer under scrubbing (see MAX_WC_TOTAL_SESSIONS).
 *
 * Both loops always either free a session or bail, so neither can spin.
 */
function reserveSession(software: boolean, priority: WcLeasePriority): boolean {
  // Preload shells must leave a slot free for the playhead, and never spend warm parks or preempt —
  // those exist to make the NEXT cut instant.
  const headroom = priority === "preload" ? 1 : 0;
  while (activeOf(software) + idleCountOf(software) + headroom >= sessionCap(software)) {
    if (priority === "preload") return false;
    const evictIndex = pickEvictIndex((entry) => entry.software === software);
    if (evictIndex !== -1) {
      const evicted = idle.splice(evictIndex, 1)[0]!;
      disposeTraced(evicted.provider, evicted.url, "pool-evict-mode-cap");
      continue;
    }
    const victim = oldestPreloadLease(software);
    if (!victim) return false;
    victim.preempt(); // frees its session synchronously
  }
  while (totalSessions() + headroom >= MAX_WC_TOTAL_SESSIONS) {
    if (priority === "preload") return false;
    // Drop a park of the OTHER mode first: this mode's parks are the ones we might still warm-reuse.
    let evictIndex = pickEvictIndex((entry) => entry.software !== software);
    if (evictIndex === -1) evictIndex = pickEvictIndex((entry) => entry.software === software);
    if (evictIndex !== -1) {
      const evicted = idle.splice(evictIndex, 1)[0]!;
      disposeTraced(evicted.provider, evicted.url, "pool-evict-total-cap");
      continue;
    }
    const victim = oldestPreloadLease(software) ?? oldestPreloadLease(!software);
    if (!victim) return false;
    victim.preempt();
  }
  return true;
}

/**
 * Rank the request that just missed the cap against the incumbents holding the slots, and RECORD the
 * denial (ADR-012 §6.12 — exceeding a budget is reported and the excess attributed).
 *
 * Deliberately returns nothing. Admission is being made observable one commit before it is made
 * authoritative, so the very first thing anyone sees from S4.3 is evidence gathered while behaviour is
 * still byte-identical to today's. If the ranking is wrong, it is wrong in a log rather than in the
 * picture — and the programme has now twice paid for a decision input that turned out not to exist at
 * the decision point (S3.3's joiner time, S4.7's `requestedTime`), which is precisely the class of
 * mistake this ordering surfaces for free.
 *
 * First-request time is `acquiredAt` for incumbents and now for the newcomer, so aging cannot yet lift a
 * source that has been retrying for seconds — a lease that failed left no record to age. That gap is
 * real and belongs to the authoritative half, where a denied candidate has to persist to be re-ranked.
 */
function reportAdmissionDenial(
  url: string,
  software: boolean,
  priority: WcLeasePriority,
  contribution: VisibleContribution | undefined
): void {
  // R1, and this one is mine: `rankAdmission` allocates a candidate array and sorts it, so the guard
  // inside `noteAdmissionDenied` is too late — the work is already done by the time it returns. A cap
  // miss is not a hot path, but the rule is that instrumentation costs nothing when off, not that it
  // costs little somewhere unimportant. `admissionDenials` is therefore a diagnostics-only figure and
  // reads 0 with diagnostics disabled; `capMisses` is the unconditional counter beside it.
  if (!kernelDiagnostics.enabled) return;
  const now = nowMs();
  const candidates: AdmissionCandidate[] = [];
  for (const record of activeLeases) {
    if (record.software !== software) continue;
    candidates.push({
      key: record.url,
      priority: record.priority,
      contribution: record.contribution,
      firstRequestedAtMs: record.acquiredAt,
      admittedAtMs: record.acquiredAt,
    });
  }
  candidates.push({ key: url, priority, contribution, firstRequestedAtMs: now, admittedAtMs: null });
  const decision = rankAdmission(candidates, sessionCap(software), now);
  for (const denial of decision.denied) noteAdmissionDenied(defaultSession, denial);
  admissionDenialCount += decision.denied.length;
}

function oldestPreloadLease(software: boolean): LeaseRecord | null {
  let oldest: LeaseRecord | null = null;
  for (const record of activeLeases) {
    if (record.priority !== "preload" || record.software !== software) continue;
    if (!oldest || record.acquiredAt < oldest.acquiredAt) oldest = record;
  }
  return oldest;
}

/**
 * Reserve a decoder slot for `url`, or null when the cap is reached / the flag is off.
 * The slot is held from this call until `release()` — including while init is in flight —
 * so concurrent mounts can never oversubscribe the hardware.
 */
export function acquirePreviewFrameProvider(url: string, options: AcquireOptions = {}): PreviewFrameLease | null {
  if (!getWcPreviewDecodeEnabled()) return null;
  const priority: WcLeasePriority = options.priority ?? "playhead";
  const software = options.preferSoftware ?? false;
  // Warm same-URL reuse first (does not change the session count: idle providers hold sessions).
  //
  // The DECODE MODE is part of the match, not just the URL. A Flarex comp routinely loads the same file
  // as both the host clip and a MediaIn source; the loader creates a SOFTWARE decoder for it and parks
  // it on release, and a URL-only match then handed that software provider to the HOST. The host is
  // lag-intolerant by design, so a software decode of a full-res source pushed it past WC_HOLD_LAG_S →
  // freeze-hold → sustained-hold bail → `wcBailedSources` → native `<video>` for the rest of the
  // session: the host frozen while the loaders played (2026-07-27). The reverse leak is just as bad — a
  // loader inheriting the host's hardware provider is back on the contended block this all exists to
  // avoid. A parked provider's decoder cannot be reconfigured, so the mode has to be matched, not coerced.
  //
  // Retentions are expired FIRST, so a park that outlived its residency can neither be warm-reused as
  // "retained" nor protect itself from the eviction loops below. The deadline is meaningless if the
  // only path that reads it is the one that evicts.
  expireRetentions(nowMs());
  const idleIndex = findWarmIdleIndex(idle, url, software);
  let warm: FrameProvider | null = null;
  if (idleIndex !== -1) {
    const entry = idle.splice(idleIndex, 1)[0]!;
    warm = entry.provider;
    // The number this slice is judged on: a warm reuse of a RETAINED park is a decoder that today's
    // FIFO would have thrown away — a demux, a sample index and a GOP window not paid for twice.
    if (entry.retainUntil > 0) retentionHits += 1;
    reused += 1;
    traceEvent({ event: "warm-reuse", provider: warm, asset: traceAsset(url), reason: "explicit" });
  } else {
    // ATTACH before RESERVING. Order is warm reuse → attach → reserve: a warm park is an
    // already-paid-for session with no sharing complexity (taking it leaves the total unchanged —
    // idle-1, active+1), so it wins; only when there is no park do we prefer sharing a live session
    // over spending a new slot. A session still INITIALIZING is attachable too, and deliberately so:
    // two layers mounting in the same tick is the single most common real case, and without it the
    // dedupe would miss the exact scenario it exists for.
    const existing =
      getWcSessionShareEnabled() && !options.exclusive ? chooseSatisfyingSession(url, software, options, priority) : null;
    if (existing) {
      shared += 1;
      traceEvent({
        event: "acquire",
        provider: existing.provider,
        asset: traceAsset(url),
        reason: "explicit",
        note: `shared software=${existing.software} priority=${priority}`,
      });
      // S3.3 (revised done-when): RECORD the grant. Do NOT judge it.
      //
      // The predicate is `findAttachableSession` above and it is untouched — deciding whether a borrow
      // is SAFE needs per-source requested times, which are ADR-012 §3.11's input set and therefore
      // S4.7's slice, not this one. What S3.3 owes is the evidence that slice gets written against, so
      // the eventual predicate is derived from borrows that actually happened rather than guessed.
      //
      // Read AFTER `findAttachableSession` and BEFORE `attachMember`, which is the only instant the two
      // participants are distinguishable: once attached, the joiner is just another member. The
      // incumbents' times are whatever they are asking for right now; the joiner's does not exist yet
      // (see BorrowTimeUnavailable) and is recorded as unavailable rather than invented.
      noteBorrowGrant(defaultSession, {
        key: url,
        incumbentTimes: [...existing.members].map((member) => member.requestedTime),
        incumbentCount: existing.members.size,
        joinerPriority: priority,
        // The session's EFFECTIVE priority (`recomputeSessionPriority`: playhead if any member is), not
        // any one member's. That is the number the 2026-08-02 finding turns on — a `preload` joiner
        // against a `playhead` incumbent is the shape that cost the on-screen clip its supply.
        incumbentPriority: existing.record.priority,
        grounds: {
          keyMatched: true,
          softwareCompatible: canAttachToSession(existing.software, software),
          joinerSoftware: software,
          incumbentSoftware: existing.software,
        },
      });
      // No `reserveSession`, no `bumpActive` — the session is already counted, and that is the point.
      return attachMember(existing, options);
    }
    if (!reserveSession(software, priority)) {
      capMisses += 1;
      traceEvent({ event: "cap-miss", asset: traceAsset(url), reason: "explicit", note: `software=${software} priority=${priority}` });
      // S4.3, OBSERVABILITY HALF (behaviour-neutral). Who lost, and to what — `capMisses` is a number
      // with no subject, and "the fourth MediaIn never gets a decoder" and "the fourth MediaIn is denied
      // at rank 5 of 8 behind three fully-occluded sources" are the same defect with and without a
      // diagnosis. Ranking runs here but decides NOTHING: the caller still falls back exactly as before,
      // so this can be read in the product before the switch is ever flipped ("instrument before switch").
      reportAdmissionDenial(url, software, priority, options.contribution);
      return null;
    }
  }
  traceEvent({
    event: "acquire",
    provider: warm,
    asset: traceAsset(url),
    reason: "explicit",
    note: `${warm ? "warm" : "cold"} software=${software} priority=${priority}`,
  });
  bumpActive(software, 1);
  // Paired with the `noteDecoderSessionClosed` in `tearDownSession`. Attaches deliberately do NOT note
  // an open: the ledger counts SESSIONS, and a share is one session — the same reason `bumpActive` is
  // skipped on that path.
  noteDecoderSessionOpened(defaultSession, url);

  const session = createSession(url, software, priority, warm, options.contribution);
  // Unshareable in BOTH directions: skipping the join above only stops this consumer taking someone
  // else's session, and would leave the host free to attach to THIS one on its next acquire — the same
  // divergence, arrived at from the other side.
  if (options.exclusive) session.shareable = false;
  return attachMember(session, options);
}

function parkOrDispose(url: string, provider: FrameProvider, software: boolean, retain = false) {
  traceEvent({ event: "park", provider, asset: traceAsset(url), reason: "explicit" });
  if (retain) retentions += 1;
  idle.push({ url, provider, software, retainUntil: retain ? nowMs() + DECODER_RETENTION_MS : 0 });
  // Enforce the GLOBAL session cap here too, not just the idle-cache size: a lease released while
  // its init was still in flight stops counting toward its active count immediately, but its decoder
  // parks here when the init resolves — without this check that path pinned active+idle = 5 real
  // sessions (seen in the 2026-07-03 smoke stats) on hardware that has ~3.
  //
  // The FIFO became a PREFERENCE ordering in S3.3: among parks, one a declared source still needs goes
  // last. This is the whole behavioural delta of the slice — a comp with four loaders used to lose two
  // decoders to this loop on a re-render, and which two was decided by mount order.
  while (idle.length > MAX_IDLE) {
    const index = pickEvictIndex(() => true);
    const evicted = idle.splice(index === -1 ? 0 : index, 1)[0]!;
    disposeTraced(evicted.provider, evicted.url, "pool-evict-idle-cap");
  }
  // ...the per-mode cap, dropping only parks of the OVERSUBSCRIBED mode: a parked software loader must
  // never be evicted to make room for hardware sessions it does not compete with (and vice versa).
  while (activeOf(software) + idleCountOf(software) > sessionCap(software)) {
    const evictIndex = pickEvictIndex((entry) => entry.software === software);
    if (evictIndex === -1) break;
    const evicted = idle.splice(evictIndex, 1)[0]!;
    disposeTraced(evicted.provider, evicted.url, "pool-evict-mode-cap");
  }
  // ...and the TOTAL ceiling, which a park can push over on its own (a lease released mid-init stops
  // counting as active immediately but still parks a real decoder when the init resolves).
  while (totalSessions() > MAX_WC_TOTAL_SESSIONS && idle.length > 0) {
    const index = pickEvictIndex(() => true);
    const evicted = idle.splice(index === -1 ? 0 : index, 1)[0]!;
    disposeTraced(evicted.provider, evicted.url, "pool-evict-total-cap");
  }
}

export interface WcPoolStats {
  /** HARDWARE sessions in flight (the GPU video block). The host/timeline clips live here. */
  active: number;
  /** SOFTWARE sessions in flight (CPU threads). Flarex virtual loaders live here. */
  activeSoftware: number;
  idle: number;
  reused: number;
  created: number;
  /** Of `created`, how many were software-decoded (Flarex virtual loaders off the hardware block). */
  createdSoftware: number;
  /**
   * Acquisitions refused because the mode's cap was full → the caller fell back to a native `<video>`.
   * A non-zero value while a Flarex comp plays is the starvation signature: read it WITH `active` to
   * see which pool ran out.
   */
  capMisses: number;
  initFailures: number;
  preemptions: number;
  activePreload: number;
  /** Acquisitions that ATTACHED to a live session instead of spending a new slot. */
  shared: number;
  /** Sessions currently serving more than one lease. */
  sharedActive: number;
  /** Shares split because their members' requested times diverged. */
  shareDetaches: number;
  /**
   * `getFrame` calls served through a session with >1 lease, and how many of those were answered
   * without a decode. The first three counters say sharing EXISTS; only this ratio says whether it
   * SAVES WORK — a share whose members never land on the same timestamp costs bookkeeping and
   * returns nothing, and would be indistinguishable from a healthy one without it. Same lesson as
   * the mode-mismatched warm reuse that "looks like a perfectly healthy cache HIT".
   */
  sharedFramesServed: number;
  sharedFrameHits: number;
  /**
   * Decodes killed by `GET_FRAME_WEDGE_TIMEOUT_MS`. Expected to be 0 forever — this is the backstop
   * for a case never yet observed in the wild. A NON-zero value is the interesting reading: it means
   * a decoder genuinely stopped answering, which is the permanent-freeze scenario the timeout exists
   * to convert into a recoverable one. Distinct from `preemptions`, which counts slot pressure.
   */
  wedgeTimeouts: number;
  /** Parks currently held past the idle FIFO because a declared source still needs them (S3.3). */
  retainedIdle: number;
  /** Releases the kernel overruled — i.e. decoders a component unmount did NOT destroy. */
  retentions: number;
  /**
   * Retained parks that were warm-reused before expiring. THE ratio that says whether kernel-owned
   * lifetime pays: `retentionHits / retentions` near zero means the residency is protecting decoders
   * nothing comes back for, which is cost with no benefit and the signal to re-tune or revert.
   */
  retentionHits: number;
  /** Retentions that hit their residency deadline unused (I-31 — the expiry half of a bounded wait). */
  retentionExpiries: number;
  /** Retained parks evicted anyway because a cap demanded it. Retention is a preference, not a veto. */
  retentionOverrides: number;
  /**
   * Borrows the S4.7 satisfaction predicate declined (0 when the flag is off).
   *
   * Read BESIDE `shareDetaches`, never alone: together they are the whole slice. Refusals rising while
   * detaches fall to zero is the predicate working — harm prevented up front instead of repaired after
   * four bad frames. Refusals rising while detaches stay at zero AND `capMisses` rises is the
   * too-strict predicate this slice names as its own risk, spending the sessions sharing exists to save.
   */
  borrowRefusals: number;
  /**
   * Cap misses that admission could ATTRIBUTE (S4.3). Behaviour-neutral today: ranking runs, records who
   * should have lost, and changes nothing about who actually did. A gap between this and `capMisses`
   * means producers are still not declaring — the wiring, measurable rather than assumed.
   */
  admissionDenials: number;
}

export function getWcPoolStats(): WcPoolStats {
  let activePreload = 0;
  for (const record of activeLeases) {
    if (record.priority === "preload") activePreload += 1;
  }
  let sharedActive = 0;
  for (const session of sharedSessions) {
    if (session.refCount > 1) sharedActive += 1;
  }
  let retainedIdle = 0;
  const at = nowMs();
  for (const entry of idle) {
    if (entry.retainUntil > at) retainedIdle += 1;
  }
  return {
    retainedIdle,
    retentions,
    retentionHits,
    retentionExpiries,
    retentionOverrides,
    borrowRefusals,
    admissionDenials: admissionDenialCount,
    shared,
    sharedActive,
    shareDetaches,
    sharedFramesServed,
    sharedFrameHits,
    wedgeTimeouts,
    active: activeSessions,
    activeSoftware: activeSoftwareSessions,
    idle: idle.length,
    reused,
    created,
    createdSoftware,
    capMisses,
    initFailures,
    preemptions,
    activePreload,
  };
}

// Debug handle, matching the repo's __rf* telemetry convention.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__rfWcPool", {
    configurable: true,
    get: () => getWcPoolStats(),
  });
}
