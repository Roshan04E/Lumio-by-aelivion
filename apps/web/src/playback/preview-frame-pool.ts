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

export interface PreviewFrameLease {
  /** Resolves to the provider, or null when init/probe failed (caller → `<video>` fallback). */
  readonly ready: Promise<FrameProvider | null>;
  /** Idempotent. Parks a healthy provider for same-URL reuse; disposes otherwise. */
  release(): void;
  /** Update pending/pre-roll ↔ live status so preemption picks the right victims. */
  setPriority(priority: WcLeasePriority): void;
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
  let priority: WcLeasePriority = options.priority ?? "playhead";
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
  } else if (!reserveSession(software, priority)) {
    capMisses += 1;
    traceEvent({ event: "cap-miss", asset: traceAsset(url), reason: "explicit", note: `software=${software} priority=${priority}` });
    return null;
  }
  traceEvent({
    event: "acquire",
    provider: warm,
    asset: traceAsset(url),
    reason: "explicit",
    note: `${warm ? "warm" : "cold"} software=${software} priority=${priority}`,
  });
  bumpActive(software, 1);

  let released = false;
  let preempted = false;
  let liveProvider: FrameProvider | null = warm;
  const record: LeaseRecord = {
    url,
    priority,
    acquiredAt: Date.now(),
    software,
    preempt() {
      if (released) return;
      released = true;
      preempted = true;
      preemptions += 1;
      bumpActive(software, -1);
      activeLeases.delete(record);
      if (liveProvider) {
        // The session must actually free NOW (that's the point of preemption) — dispose, don't park.
        disposeTraced(liveProvider, url, "preempt");
        liveProvider = null;
      }
      try {
        options.onPreempted?.();
      } catch {
        /* victim callback must not break the acquiring path */
      }
    },
  };
  activeLeases.add(record);

  const ready: Promise<FrameProvider | null> = warm
    ? Promise.resolve(warm)
    : // frameBudgetMs: preview must never block a frame request for seconds while a sparse-keyframe
      // source catches up after a rewind — return the stale frame and continue next call. The export
      // creates its providers WITHOUT a budget and keeps blocking-until-decoded semantics.
      createFrameProvider(url, "video", { frameBudgetMs: 24, preferSoftware: options.preferSoftware ?? false })
        .then((raw) => {
          const provider = serializeFrameProvider(raw, url);
          traceAliasProvider(raw, provider);
          created += 1;
          traceEvent({ event: "create", provider, asset: traceAsset(url), reason: "explicit", note: `software=${software}` });
          if (options.preferSoftware) createdSoftware += 1;
          if (preempted) {
            // Preempted while initializing — the session is already re-spent; drop the decoder.
            disposeTraced(provider, url, "preempt-during-init");
            return null;
          }
          if (released) {
            // Released while initializing — park it warm instead of wasting the work.
            traceEvent({ event: "release", provider, asset: traceAsset(url), reason: "released-during-init" });
            parkOrDispose(url, provider, software);
            return null;
          }
          liveProvider = provider;
          return provider;
        })
        .catch(() => {
          initFailures += 1;
          traceEvent({ event: "create", asset: traceAsset(url), reason: "init-failed" });
          if (!released) {
            released = true;
            bumpActive(software, -1);
            activeLeases.delete(record);
          }
          return null;
        });

  return {
    ready,
    release() {
      if (released) return;
      traceEvent({ event: "release", provider: liveProvider, asset: traceAsset(url), reason: "explicit" });
      released = true;
      bumpActive(software, -1);
      activeLeases.delete(record);
      if (liveProvider) {
        parkOrDispose(url, liveProvider, software);
        liveProvider = null;
      }
      // Init still in flight: the .then above sees `released` and parks the provider itself.
    },
    setPriority(next: WcLeasePriority) {
      priority = next;
      record.priority = next;
    },
  };
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
}

export function getWcPoolStats(): WcPoolStats {
  let activePreload = 0;
  for (const record of activeLeases) {
    if (record.priority === "preload") activePreload += 1;
  }
  return {
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
