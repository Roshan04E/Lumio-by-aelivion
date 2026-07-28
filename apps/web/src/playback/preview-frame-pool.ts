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
 * Flag (repo convention): `?wcDecode=0|1` → localStorage `orreris.wcDecode` → `VITE_WC_DECODE` →
 * **ON** (default since 2026-07-04: long ON-flag soaks were clean, every WC failure mode self-heals
 * to the `<video>` element path, and source proxies made the decode side cheap; the flag remains
 * the kill switch). Telemetry: `window.__rfWcPool`.
 */

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

export interface PreviewFrameLease {
  /** Resolves to the provider, or null when init/probe failed (caller → `<video>` fallback). */
  readonly ready: Promise<FrameProvider | null>;
  /** Idempotent. Parks a healthy provider for same-URL reuse; disposes otherwise. */
  release(): void;
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
}

interface IdleEntry {
  url: string;
  provider: FrameProvider;
  /** Which decoder this provider actually IS. Warm reuse must match it — see `acquire`. */
  software: boolean;
}

interface LeaseRecord {
  url: string;
  priority: WcLeasePriority;
  acquiredAt: number;
  software: boolean;
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
let initFailures = 0;
let preemptions = 0;
let shared = 0;
let shareDetaches = 0;
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
 * End a session and free its slot. `mode` decides the provider's fate exactly as the pre-sharing
 * code did: a preemption must actually free the decoder NOW (dispose), a release may park it warm.
 *
 * ORDERING IS PART OF THE CONTRACT: on preemption every member's callback fires BEFORE the shared
 * provider is disposed. Notify-then-dispose, never dispose-then-notify — a member reacting
 * synchronously (switching to `<video>`, clearing a held frame) must never be able to observe a
 * half-torn session, and disposing first would make that ordering an accident of implementation.
 */
function tearDownSession(session: SharedSession, mode: "release" | "preempt"): void {
  if (session.torn) return;
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
  else parkOrDispose(session.key, provider, session.software);
}

function releaseMember(session: SharedSession, member: SharedMember): void {
  if (member.dead) return;
  member.dead = true;
  releaseMemberClone(member);
  session.members.delete(member);
  session.refCount -= 1;
  if (session.refCount <= 0) tearDownSession(session, "release");
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
        const run = provider.getFrame(sourceTimeSeconds);
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
    release() {
      if (member.dead) return;
      traceEvent({ event: "release", provider: session.provider, asset: traceAsset(session.key), reason: "explicit" });
      releaseMember(session, member);
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
  warm: FrameProvider | null
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
          tearDownSession(session, "release");
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
    const evictIndex = idle.findIndex((entry) => entry.software === software);
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
    let evictIndex = idle.findIndex((entry) => entry.software !== software);
    if (evictIndex === -1) evictIndex = idle.findIndex((entry) => entry.software === software);
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
  const idleIndex = findWarmIdleIndex(idle, url, software);
  let warm: FrameProvider | null = null;
  if (idleIndex !== -1) {
    warm = idle.splice(idleIndex, 1)[0]!.provider;
    reused += 1;
    traceEvent({ event: "warm-reuse", provider: warm, asset: traceAsset(url), reason: "explicit" });
  } else {
    // ATTACH before RESERVING. Order is warm reuse → attach → reserve: a warm park is an
    // already-paid-for session with no sharing complexity (taking it leaves the total unchanged —
    // idle-1, active+1), so it wins; only when there is no park do we prefer sharing a live session
    // over spending a new slot. A session still INITIALIZING is attachable too, and deliberately so:
    // two layers mounting in the same tick is the single most common real case, and without it the
    // dedupe would miss the exact scenario it exists for.
    const existing = getWcSessionShareEnabled() ? findAttachableSession(url, software) : null;
    if (existing) {
      shared += 1;
      traceEvent({
        event: "acquire",
        provider: existing.provider,
        asset: traceAsset(url),
        reason: "explicit",
        note: `shared software=${existing.software} priority=${priority}`,
      });
      // No `reserveSession`, no `bumpActive` — the session is already counted, and that is the point.
      return attachMember(existing, options);
    }
    if (!reserveSession(software, priority)) {
      capMisses += 1;
      traceEvent({ event: "cap-miss", asset: traceAsset(url), reason: "explicit", note: `software=${software} priority=${priority}` });
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

  return attachMember(createSession(url, software, priority, warm), options);
}

function parkOrDispose(url: string, provider: FrameProvider, software: boolean) {
  traceEvent({ event: "park", provider, asset: traceAsset(url), reason: "explicit" });
  idle.push({ url, provider, software });
  // Enforce the GLOBAL session cap here too, not just the idle-cache size: a lease released while
  // its init was still in flight stops counting toward its active count immediately, but its decoder
  // parks here when the init resolves — without this check that path pinned active+idle = 5 real
  // sessions (seen in the 2026-07-03 smoke stats) on hardware that has ~3.
  while (idle.length > MAX_IDLE) {
    const evicted = idle.shift()!;
    disposeTraced(evicted.provider, evicted.url, "pool-evict-idle-cap");
  }
  // ...the per-mode cap, dropping only parks of the OVERSUBSCRIBED mode: a parked software loader must
  // never be evicted to make room for hardware sessions it does not compete with (and vice versa).
  while (activeOf(software) + idleCountOf(software) > sessionCap(software)) {
    const evictIndex = idle.findIndex((entry) => entry.software === software);
    if (evictIndex === -1) break;
    const evicted = idle.splice(evictIndex, 1)[0]!;
    disposeTraced(evicted.provider, evicted.url, "pool-evict-mode-cap");
  }
  // ...and the TOTAL ceiling, which a park can push over on its own (a lease released mid-init stops
  // counting as active immediately but still parks a real decoder when the init resolves).
  while (totalSessions() > MAX_WC_TOTAL_SESSIONS && idle.length > 0) {
    const evicted = idle.shift()!;
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
  return {
    shared,
    sharedActive,
    shareDetaches,
    sharedFramesServed,
    sharedFrameHits,
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
