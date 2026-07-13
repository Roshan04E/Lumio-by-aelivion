/**
 * Shared <video> decoder pool (P0 decoder pool, stage 1 — see the 2026-07-02 NLE gap analysis).
 *
 * Today every mounted preview clip creates its own hidden <video> (a hardware decoder session +
 * 10–50MB of buffer) and destroys it on unmount — so cut-heavy timelines churn decoders constantly,
 * and splitting one source file into N clips pays N fresh decode+buffer warmups. Integrated GPUs only
 * expose ~2–3 concurrent hardware decode sessions, so this churn is the #1 low-end playback cost.
 *
 * This pool makes the decoder a REUSED resource instead:
 *  - `acquireVideo(src)` prefers an idle element that already holds the SAME src — the dominant
 *    editing pattern (cut → cut from one source, scrub-back, replay) gets a warm decoder with its
 *    buffer intact: instant first frame, no re-download, no decoder re-init.
 *  - Released elements are paused and parked (never handed to two owners at once); the idle set is
 *    LRU-capped at {@link MAX_IDLE} — overflow is truly torn down (src cleared + load()) so decoder
 *    and buffer memory are released, bounding the total instead of leaking warm elements.
 *  - When all idle slots are foreign-src and the cap is reached, the LRU idle element is REPURPOSED
 *    (src swapped) — element reuse without growing the pool.
 *
 * Ownership model: a lease is EXCLUSIVE. Two live clips that need the same source simultaneously
 * (transition junction between two cuts of one file, the same file layered twice) each get their own
 * element — exactly the semantics the per-clip <video> had, so nothing about play/pause/seek/rVFC in
 * `WebglMediaLayer` / `VideoPreview` changes. React StrictMode's mount→cleanup→mount just round-trips
 * the element through the idle set and adopts it straight back.
 *
 * Kill switch (repo convention): `?videoPool=0` → localStorage `kimera.videoPool` → `VITE_VIDEO_POOL`
 * → ON. Disabled means create-on-acquire / teardown-on-release — byte-for-byte today's lifecycle —
 * through the SAME code path, so there is no second implementation to drift.
 *
 * Debug handle: `window.__rfVideoPoolStats`. The Stats HUD shows the live decoder count.
 */

// Warm decoders kept for upcoming cuts / scrub-back. Small on purpose: idle buffers are memory.
const MAX_IDLE = 4;

export interface VideoLease {
  readonly video: HTMLVideoElement;
  /** Idempotent. Returns the element to the pool (or tears it down when the pool is disabled). */
  release(): void;
}

export interface VideoPoolStats {
  /** Elements currently leased to live clips (≈ concurrent decoder sessions in use). */
  active: number;
  /** Warm parked elements awaiting reuse. */
  idle: number;
  /** Lifetime counters for telemetry: how often a warm decoder was reused vs created fresh. */
  reused: number;
  created: number;
}

/** Resolution order: `?videoPool=0|1` → localStorage `kimera.videoPool` → `VITE_VIDEO_POOL` → true. */
export function getVideoPoolEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("videoPool")) {
        return truthy(new URLSearchParams(window.location.search).get("videoPool"));
      }
      const stored = window.localStorage?.getItem("kimera.videoPool");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_VIDEO_POOL;
  return env == null ? true : truthy(env);
}

interface IdleEntry {
  video: HTMLVideoElement;
  src: string;
  releasedAt: number;
}

const idle: IdleEntry[] = [];
let active = 0;
let reused = 0;
let created = 0;

const listeners = new Set<() => void>();
// Cached snapshot so `useSyncExternalStore` consumers get a STABLE object between changes (a fresh
// object every getSnapshot call would loop React's store reconciliation).
let statsSnapshot: VideoPoolStats = { active: 0, idle: 0, reused: 0, created: 0 };
let statsDirty = false;

function notify() {
  statsDirty = true;
  for (const listener of listeners) listener();
}

function createElement(src: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  created += 1;
  return video;
}

/** Truly free the element's decoder + buffer (the pre-pool unmount behaviour). */
function teardown(video: HTMLVideoElement) {
  try {
    video.pause();
    video.removeAttribute("src");
    video.load();
  } catch {
    /* a dying element must never throw into UI code */
  }
}

export function acquireVideo(src: string): VideoLease {
  let video: HTMLVideoElement | undefined;
  if (getVideoPoolEnabled()) {
    // Prefer the most recently parked element with the SAME src — warm buffer, instant frames.
    for (let i = idle.length - 1; i >= 0; i--) {
      if (idle[i]!.src === src) {
        video = idle.splice(i, 1)[0]!.video;
        reused += 1;
        break;
      }
    }
    // Idle set full of foreign sources: repurpose the LRU one (element reuse, no pool growth).
    if (!video && idle.length >= MAX_IDLE) {
      const entry = idle.shift()!;
      video = entry.video;
      try {
        video.pause();
        video.src = src;
      } catch {
        teardown(video);
        video = undefined;
      }
      if (video) reused += 1;
    }
  }
  if (!video) video = createElement(src);
  active += 1;
  let released = false;
  notify();
  return {
    video,
    release() {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      try {
        video!.pause();
      } catch {
        /* ignore */
      }
      if (getVideoPoolEnabled()) {
        idle.push({ video: video!, src, releasedAt: Date.now() });
        while (idle.length > MAX_IDLE) teardown(idle.shift()!.video);
      } else {
        teardown(video!);
      }
      notify();
    },
  };
}

export function getVideoPoolStats(): VideoPoolStats {
  if (statsDirty) {
    statsSnapshot = { active, idle: idle.length, reused, created };
    statsDirty = false;
  }
  return statsSnapshot;
}

export function subscribeVideoPoolStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Debug handle, matching the repo's __rf* telemetry convention.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__rfVideoPoolStats", {
    configurable: true,
    get: () => getVideoPoolStats(),
  });
}
