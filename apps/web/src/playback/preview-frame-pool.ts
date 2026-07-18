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

/** Hard cap ≈ the hardware decode sessions an integrated GPU actually has. */
const MAX_WC_SESSIONS = 3;
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
}

interface IdleEntry {
  url: string;
  provider: FrameProvider;
}

interface LeaseRecord {
  url: string;
  priority: WcLeasePriority;
  acquiredAt: number;
  preempt(): void;
}

let activeSessions = 0;
const idle: IdleEntry[] = [];
const activeLeases = new Set<LeaseRecord>();
let reused = 0;
let created = 0;
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
function serializeFrameProvider(provider: FrameProvider): FrameProvider {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    get width() {
      return provider.width;
    },
    get height() {
      return provider.height;
    },
    getFrame(sourceTimeSeconds: number) {
      const run = chain.then(() => provider.getFrame(sourceTimeSeconds));
      chain = run.catch(() => null);
      return run;
    },
    // MUST forward: the presenter's catch-up hold reads this after every getFrame. This wrapper
    // silently dropping it made `lag` always 0 — the hold NEVER engaged, and the rewind/seek
    // fast-forward pan survived three fix attempts (2026-07-04). Any new FrameProvider field
    // needs forwarding here or the preview pool erases it.
    get lastFrameLagSeconds() {
      return provider.lastFrameLagSeconds ?? 0;
    },
    dispose() {
      provider.dispose();
    },
  };
}

function disposeQuietly(provider: FrameProvider) {
  try {
    provider.dispose();
  } catch {
    /* a dying decoder must never throw into UI code */
  }
}

function oldestPreloadLease(): LeaseRecord | null {
  let oldest: LeaseRecord | null = null;
  for (const record of activeLeases) {
    if (record.priority !== "preload") continue;
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
  // Warm same-URL reuse first (does not change the session count: idle providers hold sessions).
  const idleIndex = idle.findIndex((entry) => entry.url === url);
  let warm: FrameProvider | null = null;
  if (idleIndex !== -1) {
    warm = idle.splice(idleIndex, 1)[0]!.provider;
    reused += 1;
  } else if (priority === "preload") {
    // Preload shells only take a genuinely spare slot (leaving one free for the playhead) and
    // never spend warm parks — those exist to make the NEXT cut instant.
    if (activeSessions + idle.length >= MAX_WC_SESSIONS - 1) {
      capMisses += 1;
      return null;
    }
  } else if (activeSessions + idle.length >= MAX_WC_SESSIONS) {
    // Cap accounting includes idle providers (they pin real decoder sessions). Evict the oldest
    // idle one to make room; then reclaim from preload shells; if neither, the cap is genuinely reached.
    const evicted = idle.shift();
    if (evicted) {
      disposeQuietly(evicted.provider);
    } else {
      const victim = oldestPreloadLease();
      if (victim) {
        victim.preempt(); // frees its session synchronously
      } else {
        capMisses += 1;
        return null;
      }
    }
  }
  activeSessions += 1;

  let released = false;
  let preempted = false;
  let liveProvider: FrameProvider | null = warm;
  const record: LeaseRecord = {
    url,
    priority,
    acquiredAt: Date.now(),
    preempt() {
      if (released) return;
      released = true;
      preempted = true;
      preemptions += 1;
      activeSessions = Math.max(0, activeSessions - 1);
      activeLeases.delete(record);
      if (liveProvider) {
        // The session must actually free NOW (that's the point of preemption) — dispose, don't park.
        disposeQuietly(liveProvider);
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
      createFrameProvider(url, "video", { frameBudgetMs: 24 })
        .then((raw) => {
          const provider = serializeFrameProvider(raw);
          created += 1;
          if (preempted) {
            // Preempted while initializing — the session is already re-spent; drop the decoder.
            disposeQuietly(provider);
            return null;
          }
          if (released) {
            // Released while initializing — park it warm instead of wasting the work.
            parkOrDispose(url, provider);
            return null;
          }
          liveProvider = provider;
          return provider;
        })
        .catch(() => {
          initFailures += 1;
          if (!released) {
            released = true;
            activeSessions = Math.max(0, activeSessions - 1);
            activeLeases.delete(record);
          }
          return null;
        });

  return {
    ready,
    release() {
      if (released) return;
      released = true;
      activeSessions = Math.max(0, activeSessions - 1);
      activeLeases.delete(record);
      if (liveProvider) {
        parkOrDispose(url, liveProvider);
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

function parkOrDispose(url: string, provider: FrameProvider) {
  idle.push({ url, provider });
  // Enforce the GLOBAL session cap here too, not just the idle-cache size: a lease released while
  // its init was still in flight stops counting toward `activeSessions` immediately, but its decoder
  // parks here when the init resolves — without this check that path pinned active+idle = 5 real
  // sessions (seen in the 2026-07-03 smoke stats) on hardware that has ~3.
  while (idle.length > MAX_IDLE || activeSessions + idle.length > MAX_WC_SESSIONS) {
    disposeQuietly(idle.shift()!.provider);
  }
}

export interface WcPoolStats {
  active: number;
  idle: number;
  reused: number;
  created: number;
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
  return { active: activeSessions, idle: idle.length, reused, created, capMisses, initFailures, preemptions, activePreload };
}

// Debug handle, matching the repo's __rf* telemetry convention.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__rfWcPool", {
    configurable: true,
    get: () => getWcPoolStats(),
  });
}
