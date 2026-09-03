/**
 * Source-proxy transcode engine: builds the per-asset ingest proxies described in
 * sourceProxyStore.ts (Premiere's proxy model — small file, dense keyframes, edit-invariant).
 *
 * Recipe: H.264 MP4, long edge ≤854 (~480p), 30fps, keyframe EVERY SECOND (the whole point:
 * playhead drops land within ~15 delta frames of a sync point), AAC audio when the source has an
 * audio track (so the proxy is a drop-in for every preview consumer — viewer modal, audio layers,
 * hover scrub — not just the video path).
 *
 * Scheduling: one transcode at a time, FIFO, entirely background. The decode side runs
 * `preferSoftware` so it never competes with playback for the ~3 hardware decoder sessions; the
 * encode side keeps the hardware encoder (idle during preview). Every frame round-trips through
 * awaited promises + a periodic breather sleep, so the main thread stays responsive.
 *
 * Consumers call `ensureSourceProxy(asset, onReady)`. Fast path: a valid persisted proxy resolves
 * from OPFS immediately. Slow path: the asset joins the queue and `onReady` fires (possibly many
 * minutes later) with a session object URL to patch into `SourceAsset.proxyUrl`. Failures are
 * remembered per-asset for the session (no retry storms). Telemetry: `window.__rfSourceProxy`.
 */

import { getAssetBlobStore } from "../../lib/asset-blob-store";
import { createTrackedObjectUrl, revokeTrackedObjectUrl } from "../../lib/object-url-registry";
import { createFrameProvider } from "../../export/source-decoder";
import { MediaEncoder, EncoderStallRecoveredError } from "../../export/video-encoder";
import { markHotSpot } from "../../lib/perfDiagnostics";
import {
  getSourceProxy,
  saveSourceProxy,
  sourceProxyStoreAvailable,
  removeSourceProxy,
  saveSourceProxySegment,
  getSourceProxySegment,
  listSourceProxySegmentIndices,
  clearSourceProxySegments,
  lastSourceProxySaveError,
  SOURCE_PROXY_VERSION,
} from "./sourceProxyStore";
import { decodeSegment } from "./sourceProxySegments";
import { buildPrefixProxy, measurePrefixCoverage } from "./sourceProxyPrefixMux";
import { probeGopProfile, needsProxyForDecodeCost, describeGopProfile, type GopProfile } from "./gop-probe";
import type { SourceProxyWorkerRequest, SourceProxyWorkerResponse } from "./sourceProxyWorkerProtocol";
import type { SourceAsset } from "@orreris/shared";

// QUALITY RECIPE v7 (2026-07-19, user report: ½-quality playback "fps is very down" vs Premiere,
// where proxies lower ONLY resolution, never motion). v6 capped proxies at 30fps — 60fps footage
// played at HALF its frame rate whenever the proxy substituted (½/¼/Auto), which read as
// choppiness no hardware could fix. The cap is now 60: sampling still follows the SOURCE's own
// cadence (24/30fps sources are byte-identical in cost and cadence to v6), only >30fps sources
// keep their motion. Bitrate scales sublinearly with fps in the transcoders (temporal compression
// gets MORE effective at high fps) so 60fps proxies land ~√2× the v6 size, not 2×.
// v6 (2026-07-18) history: 1280 long edge + 0.18 bpp ≈ 5 Mbps at 720p30 — Premiere's proxy tier.
// Bump SOURCE_PROXY_VERSION when touching ANY of these constants.
const PROXY_LONG_EDGE = 1280;
const PROXY_FPS = 60;
// Keyframe every N FRAMES (not seconds). The preview's WebCodecs pool decodes seek-on-demand and, when
// it falls behind, can only "reset its lag" by jumping to a keyframe — so the max catch-up decode is one
// GOP. A frame-count GOP keeps that ≤ N frames at ANY fps (30/60/120); the old 1-second GOP made it
// fps × 1 frames (60 at 60fps), which the decoder couldn't grind in realtime → high-fps proxies froze.
// 12 → keyframe every 0.4s@30 / 0.2s@60 / 0.1s@120; ~2–3× more keyframes than the 1s GOP (bigger file,
// the standard edit-proxy tradeoff), catch-up stays a few ms so lag never reaches the 0.35s hold cutoff.
const PROXY_KEYFRAME_EVERY_N_FRAMES = 12;
const PROXY_BITS_PER_PIXEL_FRAME = 0.18;
/** Below this the original is already cheap to decode — don't spend a transcode on it. */
const MIN_SOURCE_BYTES = 12 * 1024 * 1024;
/** Safety cap: don't background-transcode an hour-long screen recording in v1. */
const MAX_SOURCE_DURATION_S = 15 * 60;
/** Longer breather every N frames so a busy tab never feels the transcode. */
const BREATHER_EVERY_FRAMES = 30;
const BREATHER_MS = 15;
/** Audio encode yields every N chunks so it never holds the main thread (was a ~1s freeze/clip). */
const AUDIO_YIELD_EVERY_CHUNKS = 24;

/**
 * Release the main thread so QUEUED tasks — crucially the user's input handlers — can run between
 * units of transcode work. MessageChannel, not setTimeout(0): browsers clamp nested timeouts to ~4ms
 * and we want to yield after EVERY frame without pacing the transcode into the ground. `scheduler.yield`
 * (Chromium) is even better — it yields at a lower priority so input pre-empts us — so prefer it.
 */
const yieldToMain: () => Promise<void> = (() => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") {
    return () => scheduler.yield!();
  }
  if (typeof MessageChannel === "undefined") {
    return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const channel = new MessageChannel();
  let pending: Array<() => void> = [];
  channel.port1.onmessage = () => {
    const callbacks = pending;
    pending = [];
    for (const cb of callbacks) cb();
  };
  return () =>
    new Promise<void>((resolve) => {
      pending.push(resolve);
      channel.port2.postMessage(0);
    });
})();

interface SourceProxyStats {
  built: number;
  failed: number;
  skipped: number;
  queued: number;
  active: string | null;
  lastBuildMs: number;
  recent: Array<{ assetId: string; outcome: "built" | "failed" | "skipped"; ms: number; note?: string }>;
}

function stats(): SourceProxyStats {
  const w = window as unknown as { __rfSourceProxy?: SourceProxyStats };
  return (w.__rfSourceProxy ??= { built: 0, failed: 0, skipped: 0, queued: 0, active: null, lastBuildMs: 0, recent: [] });
}

/**
 * Per-asset state changed (queued → building → built/failed/skipped). UI that shows a proxy badge
 * subscribes here instead of polling: a frozen preview must read as "proxy not ready" the moment the
 * engine knows it, and an 800ms poll (the Source Viewer's, the only consumer before 2026-08-17) is
 * both late and wasteful once the badge is on every clip in the timeline.
 */
const stateListeners = new Set<() => void>();
/**
 * Settled outcome per asset for THIS SESSION, uncapped. Distinct from `stats().recent`, which is a
 * 20-entry diagnostic ring: past 20 settled assets the ring drops the oldest, and the per-asset badge
 * would then have silently reported "built" for an asset that failed. A badge that guesses is worse
 * than no badge, so the badge reads this and the ring stays a debug tail.
 */
const sessionOutcomes = new Map<string, { outcome: "built" | "failed" | "skipped"; note?: string }>();

/** Assets that joined the CURRENT drain — the population the completion notice is allowed to speak for. */
const drainAssetIds = new Set<string>();

export interface SourceProxyDrainSummary {
  /** Assets that joined this drain, whatever happened to them. */
  total: number;
  built: number;
  /** Tried and could not finish, retries exhausted. These clips still play their originals. */
  failed: number;
  /** Never attempted (small enough, not a video, metadata probe failed, too long). NOT a success. */
  skipped: number;
  /** Per-asset causes for the failures, for the notice/diagnostics. */
  failures: Array<{ assetId: string; note?: string }>;
}

let lastDrainSummary: SourceProxyDrainSummary | null = null;

/**
 * What the drain that just finished actually did. Read when the progress listener reports null.
 *
 * EXISTS BECAUSE THE COMPLETION NOTICE WAS LYING (2026-08-17): "Media optimization finished — proxies
 * rebuilt at full quality" fired unconditionally at drain end, including the 11x4K run where 6 of 11
 * assets never got a proxy. Silence leaves a user uncertain; a false success CLOSES the question, so
 * they stop looking for the cause of a preview that is still frozen. The notice now speaks only from
 * these counts.
 */
export function getSourceProxyDrainSummary(): SourceProxyDrainSummary | null {
  return lastDrainSummary;
}

function summarizeDrain(): void {
  const failures: Array<{ assetId: string; note?: string }> = [];
  let built = 0;
  let failed = 0;
  let skipped = 0;
  for (const assetId of drainAssetIds) {
    const outcome = sessionOutcomes.get(assetId)?.outcome;
    if (outcome === "built") built += 1;
    else if (outcome === "skipped") skipped += 1;
    else {
      // Includes assets with no recorded outcome at all — counted as failed rather than quietly
      // dropped, because "we cannot say what happened to it" is not evidence that it succeeded.
      failed += 1;
      const note = sessionOutcomes.get(assetId)?.note;
      failures.push({ assetId, ...(note ? { note } : {}) });
    }
  }
  lastDrainSummary = { total: drainAssetIds.size, built, failed, skipped, failures };
  // Published alongside `__rfSourceProxy` so an out-of-page instrument can compare what the notice
  // SAYS against what the engine COUNTED — the whole point of the notice-truth probe.
  (window as unknown as { __rfProxyDrainSummary?: SourceProxyDrainSummary }).__rfProxyDrainSummary = lastDrainSummary;
  drainAssetIds.clear();
}
let stateRevision = 0;
export function subscribeSourceProxyState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}
/** Monotonic counter for `useSyncExternalStore` snapshots — a number, so the snapshot is stable. */
export function sourceProxyStateRevision(): number {
  return stateRevision;
}
function notifyStateChanged(): void {
  stateRevision += 1;
  for (const listener of stateListeners) listener();
}

function record(assetId: string, outcome: "built" | "failed" | "skipped", ms: number, note?: string): void {
  const s = stats();
  s[outcome === "built" ? "built" : outcome === "failed" ? "failed" : "skipped"] += 1;
  s.lastBuildMs = Math.round(ms);
  s.recent.push({ assetId, outcome, ms: Math.round(ms), ...(note ? { note } : {}) });
  if (s.recent.length > 20) s.recent.shift();
  sessionOutcomes.set(assetId, { outcome, ...(note ? { note } : {}) });
  notifyStateChanged();
  try {
    if (localStorage.getItem("orreris.perfLog") === "1") {
      console.info(`[source-proxy] ${assetId}: ${outcome}${note ? ` (${note})` : ""} in ${Math.round(ms)}ms`);
    }
  } catch {
    /* ignore */
  }
}

/** Note a non-settling decision (why a build is happening) without recording an outcome. */
function logProxy(assetId: string, note: string): void {
  try {
    if (localStorage.getItem("orreris.perfLog") === "1") {
      console.info(`[source-proxy] ${assetId}: ${note}`);
    }
  } catch {
    /* ignore */
  }
}

type ReadyCallback = (assetId: string, proxyUrl: string) => void;

// COLD-ORIGIN SIGNAL (2026-07-06): fires ONCE per session, the first time a REAL transcode starts
// (rehydrations and skips don't count) — a fresh browser origin (e.g. the vite-preview :4173 build,
// whose OPFS is separate from dev's :5173) has no proxies yet, and the UI shows a passive
// "optimizing media" notice so softer first-session playback is expected, not alarming.
let firstBuildNotified = false;
let firstBuildListener: (() => void) | null = null;
export function setSourceProxyFirstBuildListener(listener: (() => void) | null): void {
  firstBuildListener = listener;
}
function notifyFirstBuild(): void {
  if (firstBuildNotified) return;
  firstBuildNotified = true;
  firstBuildListener?.();
}

// LIVE PROGRESS (2026-07-18, user report: the one-shot cold-origin notice wasn't enough — silent
// builds + ingest jank read as "the timeline froze"). The engine emits STEPPED progress (every 5%,
// plus asset changes and the final null = queue drained) so the UI can mirror it into the notice
// line without being spammed. `queued` counts builds still waiting behind the active one.
export interface SourceProxyProgress {
  assetId: string;
  /** 0..100, stepped to 5s. */
  percent: number;
  queued: number;
  /**
   * The ACTIVE source's own pixel height (1080, 2160, …), or null before the metadata probe answers.
   * Carried because the honest description of "playing while this builds" DIFFERS BY RESOLUTION: at
   * 1080p the original plays softer; at 4K the measured truth (2026-08-17) is a preview that does not
   * advance at all. A notice that says "softer" over a frozen 4K preview is the same defect one layer
   * up from the freeze itself, so the copy is derived from this rather than assumed.
   */
  sourceHeight: number | null;
}
let progressListener: ((progress: SourceProxyProgress | null) => void) | null = null;
let progressAssetId: string | null = null;
let progressSourceHeight: number | null = null;
let progressLastStep = -1;
export function setSourceProxyProgressListener(listener: ((progress: SourceProxyProgress | null) => void) | null): void {
  progressListener = listener;
}
function reportProgress(encodedFrames: number, totalFrames: number): void {
  if (!progressListener || !progressAssetId || totalFrames <= 0) return;
  const percent = Math.max(0, Math.min(100, Math.round((encodedFrames / totalFrames) * 100)));
  const step = Math.floor(percent / 5);
  if (step === progressLastStep) return;
  progressLastStep = step;
  progressListener({ assetId: progressAssetId, percent, queued: queue.length, sourceHeight: progressSourceHeight });
}

// SUSPEND (2026-07-06, supersedes the full-quality-only rule): builds park during ANY playback —
// on a cold origin the build started the moment play did and starved the live decode path (the
// build-only "plays ~4s then freezes" report). EditorPage suspends the engine whenever isPlaying;
// builds resume on pause. Checked between builds AND inside the frame loop (worker builds get the
// flag forwarded as a message), so an in-flight transcode parks within one frame.
let buildSuspended = false;
const suspendListeners = new Set<(suspended: boolean) => void>();
export function setSourceProxyBuildSuspended(suspended: boolean): void {
  buildSuspended = suspended;
  for (const notify of suspendListeners) notify(suspended);
}
async function waitWhileSuspended(): Promise<void> {
  while (buildSuspended) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Session memory: settled assets (built / permanently skipped / failed) + in-queue ids.
const settled = new Set<string>();
const inQueue = new Set<string>();

/**
 * MEASURED-DENSE SOURCES (2026-07-28). Assets whose GOP profile was actually probed and came back
 * keyframe-dense enough that no proxy was warranted. This is the positive half of the probe's verdict,
 * which the engine previously computed and threw away.
 *
 * It exists because `VideoPreview` had to INFER decode cost from `mediaUrl !== asset.proxyUrl` — "no
 * proxy, therefore expensive to seek, therefore force the `<video>` element decoder". That is the same
 * shape of inference as the file-size gate this probe replaced (v32j), and it fails the same way: a
 * source can lack a proxy precisely BECAUSE it was measured cheap, and it then gets pushed onto the
 * element path — which for a Flarex loader is the freeze `WebglMediaLayer` warns about. The source was
 * measured safe for WebCodecs and sent to the slow path anyway, for want of somewhere to put the
 * answer.
 *
 * Membership requires a POSITIVE measurement. A `null` profile ("cannot tell" — WebM, oversized, no
 * `stss` box) never lands here, so every caller keeps its existing conservative behaviour unless the
 * probe actually said dense. This set only ever ADDS permission to use the pooled decoder, mirroring
 * the probe's own doctrine that it only ever adds a reason to build.
 */
const measuredDenseGop = new Set<string>();

// Declared eagerly so `'__rfDenseGop' in window` answers "is this build current?" rather than "has
// anything been measured yet?". A presence test that only becomes true once the feature fires cannot
// tell an absent feature from an idle one — the failure that voided the first flarexSwDecode A/B.
try {
  const w = window as unknown as { __rfDenseGop?: Array<{ assetId: string; gop: string }> };
  w.__rfDenseGop ??= [];
} catch {
  /* SSR / non-browser */
}

/**
 * True only if this asset's GOP was measured and found dense. False for unprobed, unmeasurable and
 * sparse sources alike — callers must treat it as "known cheap", never as "not known expensive".
 */
export function hasMeasuredDenseGop(assetId: string | null | undefined): boolean {
  return !!assetId && measuredDenseGop.has(assetId);
}

// A skip decision arrives asynchronously, after the probe. Renderers that consult
// `hasMeasuredDenseGop` during render would otherwise keep whatever they concluded before the answer
// existed — correct only by luck of an unrelated re-render. Fires once per newly-measured asset.
let denseGopListener: ((assetId: string) => void) | null = null;
export function setSourceProxyDenseGopListener(listener: ((assetId: string) => void) | null): void {
  denseGopListener = listener;
}
function noteMeasuredDense(assetId: string, profile: GopProfile | null): void {
  if (!profile || measuredDenseGop.has(assetId)) return;
  measuredDenseGop.add(assetId);
  // Published for diagnosis AND as this change's build-presence test. The end-to-end signal for the
  // dense-GOP path is `__rfSourceMap` reading `wc-*` instead of `element` — but a bundle that predates
  // the change also reads `element`, so the observable outcome cannot distinguish "not working" from
  // "not present". Declared unconditionally at module scope below so the symbol exists even when
  // nothing has been measured yet; an empty array and a missing global must not look alike.
  try {
    const w = window as unknown as { __rfDenseGop?: Array<{ assetId: string; gop: string }> };
    (w.__rfDenseGop ??= []).push({ assetId, gop: describeGopProfile(profile) });
  } catch {
    /* ignore */
  }
  try {
    denseGopListener?.(assetId);
  } catch {
    /* a listener fault must never fail the build decision */
  }
}
const queue: Array<{ asset: SourceAsset; onReady: ReadyCallback }> = [];
let draining = false;

// Truncated / flaky remote downloads (notably the R2 `/storage` proxy cutting a stream short —
// ERR_CONTENT_LENGTH_MISMATCH) are TRANSIENT. Surfaced as this error, drainQueue re-queues the asset
// with backoff instead of settling it as a permanent "skipped" (which stranded the whole queue on flaky
// media — the "queued 28, sources play heavy originals, playback freezes" report). After the cap it
// settles as "failed" so the asset stops looping and the UI can show a real failure.
/**
 * Base for every TRANSIENT build failure: `drainQueue` re-queues these with backoff (bounded by
 * {@link PROXY_BUILD_MAX_RETRIES}) instead of settling the asset. Anything not derived from this is
 * terminal for the session.
 *
 * Widened from fetch-only on 2026-08-17. The 11x4K measurement built only 5 of 11 proxies, and two of
 * the six losses were transient conditions being treated as permanent: a wedged-then-reset encoder
 * (recoverable BY CONSTRUCTION — `EncoderStallRecoveredError` exists to be resumed from) and a persist
 * failure that discarded an already-completed transcode. Each stranded its clip on the 4K original for
 * the whole session, which on 4K means a preview frozen 100% of the time (DEBT-033 update (c)).
 */
class RetryableProxyBuildError extends Error {}
class RetryableProxyFetchError extends RetryableProxyBuildError {}
/** A COMPLETED transcode that could not be persisted. Retrying re-does the transcode, which is
 *  expensive — but losing it outright is the worse of the two, and the cause is now reported. */
class RetryableProxyPersistError extends RetryableProxyBuildError {}
/** A wedged-then-reset encoder reported by the worker, which cannot resume in place (see its own
 *  note) and hands the retry decision here. The segment cache makes the rebuild cheap. */
class RetryableProxyEncoderStallError extends RetryableProxyBuildError {}
/**
 * THE BOUND, STATED. Each asset gets at most 3 re-queues per session (backoff 2s, 4s, 6s), after
 * which it settles as `failed` and the UI reports it. Retrying is right because the failures above
 * are transient by construction; BOUNDING it is equally right, because a wedge that recurs on every
 * attempt would otherwise loop forever over a genuinely broken asset — an unbounded retry is a new
 * defect, not a fix. A settled failure is a stated outcome the user can act on; a loop is not.
 */
const PROXY_BUILD_MAX_RETRIES = 3;
const PROXY_BUILD_RETRY_BACKOFF_MS = 2000;
const buildRetries = new Map<string, number>();
/**
 * In-place encoder-stall resumes allowed within ONE main-thread transcode before it gives up and
 * hands the (bounded) retry decision to the queue. 2 matches the encoder's own internal reset budget
 * in `video-encoder.ts`, applied one level up so a permanently wedging encoder cannot spin here.
 */
const MAX_ENCODER_STALL_RESUMES = 2;

export type SourceProxyState = "building" | "queued" | "built" | "failed" | "skipped" | "none";

/**
 * Per-asset proxy state — the data primitive for UI feedback (a badge on the asset/clip tile telling
 * the user a source is still building / failed / incomplete, so a frozen preview reads as "proxy not
 * ready" instead of a silent hang) and for the frame-profiler's media-supply report. Derived purely
 * from the live sets the engine already maintains — no new bookkeeping.
 *   building — this asset is the active transcode right now.
 *   queued   — waiting behind the active build.
 *   built/failed/skipped — settled; the most-recent recorded outcome for this asset.
 *   none     — never queued (small enough / not a video / not yet requested).
 */
export function getSourceProxyState(assetId: string): SourceProxyState {
  const s = stats();
  if (s.active === assetId) return "building";
  if (inQueue.has(assetId)) return "queued";
  if (settled.has(assetId)) return sessionOutcomes.get(assetId)?.outcome ?? "built";
  return "none";
}

/**
 * DIAGNOSTIC: force a fresh rebuild of one asset's proxy. Deletes the persisted blob and clears the
 * per-session guards (`settled`/`inQueue`/`buildRetries` + the recent record) so `ensureSourceProxy`
 * treats the asset as brand new and re-transcodes it — used by the Source Viewer's "Rebuild proxy"
 * control to re-run the recipe (and print the build log) for an asset whose proxy looks degraded.
 * `onReady` fires once on success with the new proxy URL. Not used by any automatic path.
 */
export async function rebuildSourceProxy(asset: SourceAsset, onReady: ReadyCallback = () => undefined): Promise<void> {
  await removeSourceProxy(asset.id).catch(() => undefined);
  retirePartialProxy(asset.id); // its segments are gone too — nothing to keep offering
  settled.delete(asset.id);
  inQueue.delete(asset.id);
  buildRetries.delete(asset.id);
  const s = stats();
  s.recent = s.recent.filter((r) => r.assetId !== asset.id);
  sessionOutcomes.delete(asset.id);
  ensureSourceProxy(asset, onReady);
}

/**
 * Make sure `asset` has an ingest proxy: resolves an existing one immediately, otherwise queues a
 * background transcode. `onReady` fires at most once, only on success. Safe to call repeatedly
 * (idempotent per session).
 */
export function ensureSourceProxy(asset: SourceAsset, onReady: ReadyCallback): void {
  if (settled.has(asset.id) || inQueue.has(asset.id)) return;
  if (!asset.fileType?.startsWith("video/")) {
    settled.add(asset.id);
    return;
  }
  inQueue.add(asset.id);
  queue.push({ asset, onReady });
  stats().queued = queue.length;
  drainAssetIds.add(asset.id);
  notifyStateChanged();
  if (!draining) {
    draining = true;
    // Start the drain only when the tab is IDLE, so a background transcode never lands on top of the
    // user's initial open-and-edit burst. requestIdleCallback fires when the main thread has spare
    // time (and re-checks each build via the same gate through drainQueue → whenIdle); a timeout
    // fallback guarantees it still runs on browsers without rIC.
    whenIdle(() => void drainQueue());
  }
}

/** Resolve when the main thread is idle (requestIdleCallback), or after a short fallback delay. */
function whenIdle(run: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (typeof ric === "function") {
    ric(run, { timeout: 4000 });
  } else {
    setTimeout(run, 1500);
  }
}

async function drainQueue(): Promise<void> {
  try {
    if (!(await sourceProxyStoreAvailable())) {
      // No OPFS → feature off for this session; mark everything settled so we don't loop.
      for (const item of queue.splice(0)) {
        settled.add(item.asset.id);
        inQueue.delete(item.asset.id);
      }
      return;
    }
    while (queue.length > 0) {
      const item = queue.shift()!;
      stats().queued = queue.length;
      // Wait for an idle window before starting each build so an active editing burst always wins
      // the main thread; the per-frame yields inside buildOne keep it responsive once running.
      await new Promise<void>((resolve) => whenIdle(resolve));
      await waitWhileSuspended();
      stats().active = item.asset.id;
      progressAssetId = item.asset.id;
      progressSourceHeight = null; // unknown until this build's metadata probe answers
      notifyStateChanged();
      progressLastStep = -1;
      const started = performance.now();
      let requeued = false;
      try {
        const url = await buildOne(item.asset);
        if (url) {
          record(item.asset.id, "built", performance.now() - started);
          buildRetries.delete(item.asset.id);
          item.onReady(item.asset.id, url);
        }
      } catch (error) {
        const attempts = (buildRetries.get(item.asset.id) ?? 0) + 1;
        if (error instanceof RetryableProxyBuildError && attempts <= PROXY_BUILD_MAX_RETRIES) {
          // Transient (truncated download, wedged-then-reset encoder, failed persist) — keep it inQueue
          // (dedupes external re-requests) but out of the array until the backoff elapses, then re-add
          // and restart the drain.
          buildRetries.set(item.asset.id, attempts);
          record(item.asset.id, "failed", performance.now() - started, `${error.message} — retry ${attempts}/${PROXY_BUILD_MAX_RETRIES}`);
          requeued = true;
          setTimeout(() => {
            if (settled.has(item.asset.id)) return; // superseded (e.g. built from local bytes since)
            queue.push(item);
            stats().queued = queue.length;
            if (!draining) {
              draining = true;
              void drainQueue();
            }
          }, PROXY_BUILD_RETRY_BACKOFF_MS * attempts);
        } else {
          record(item.asset.id, "failed", performance.now() - started, error instanceof Error ? error.message : String(error));
          buildRetries.delete(item.asset.id);
        }
      } finally {
        if (!requeued) {
          settled.add(item.asset.id);
          inQueue.delete(item.asset.id);
        }
        stats().active = null;
        progressAssetId = null;
        progressSourceHeight = null;
        notifyStateChanged();
        if (queue.length === 0) {
          summarizeDrain(); // computed BEFORE the null so the notice has real counts to read
          progressListener?.(null); // drained — the UI clears/summarizes its notice
        }
      }
    }
  } finally {
    draining = false;
    // Work may have arrived while the tail of the loop ran.
    if (queue.length > 0 && !draining) {
      draining = true;
      void drainQueue();
    }
  }
}

/** Returns the proxy URL, or null when skipped (already settled via `record`). Throws on failure. */
async function buildOne(asset: SourceAsset): Promise<string | null> {
  const store = await getAssetBlobStore();
  let blob = await store.getBlob(asset.id);
  let sourceUrl = blob ? await store.getObjectUrl(asset.id) : null;
  let revokeSourceUrl = false;
  if (!blob) {
    // Server-hosted asset (API upload / stock download): the bytes live behind an http URL, not in
    // the on-device store. Fetch them ONCE for the transcode — the 2026-07-04 soak showed every
    // real project asset skipping as "no local bytes" because this path didn't exist.
    const remote = asset.fileUrl && /^https?:/i.test(asset.fileUrl) ? asset.fileUrl : null;
    if (!remote) {
      record(asset.id, "skipped", 0, "no local bytes");
      return null;
    }
    // Cheap pre-check via HEAD-ish metadata: a persisted proxy validates against byte size, so we
    // need the size anyway — and downloading a below-threshold file just to skip it is waste.
    try {
      const response = await fetch(remote);
      if (!response.ok) throw new Error(`fetch ${response.status}`);
      blob = await response.blob();
    } catch (error) {
      // A truncated / flaky download is transient — surface it as RETRYABLE so drainQueue re-queues it
      // (with backoff) rather than permanently skipping the asset and stranding it on the heavy original.
      throw new RetryableProxyFetchError(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // TRACKED (DEBT-019): these bytes are already RAM-resident (we just downloaded them), so
    // registering the URL stops the decoder fetching a SECOND copy of the same file.
    sourceUrl = createTrackedObjectUrl(blob);
    revokeSourceUrl = true;
  }
  try {
    return await buildFromBlob(asset, blob, sourceUrl);
  } finally {
    if (revokeSourceUrl && sourceUrl) revokeTrackedObjectUrl(sourceUrl);
  }
}

async function buildFromBlob(asset: SourceAsset, blob: Blob, sourceUrl: string | null): Promise<string | null> {
  // Fast path: a previous session already built it.
  const existing = await getSourceProxy(asset.id, blob.size);
  if (existing) {
    record(asset.id, "built", 0, "rehydrated");
    return existing.url;
  }
  // SLICE 3: whatever a previous session's interrupted build left on disk is playable RIGHT NOW.
  // Published HERE — before the GOP probe, the <video> metadata probe (15s timeout) and the audio
  // pre-decode — because "reopen and keep working at the covered range" is the whole feature, and
  // none of those steps are inputs to it: the segment guards already bind the cache to these exact
  // bytes and this recipe, and the geometry is read from the segment headers themselves.
  schedulePartialPublish(asset.id, blob.size, 1);
  // DECODE COST, NOT FILE SIZE (2026-07-28). Both size gates below used to conclude "small ⇒ cheap to
  // decode" and skip. That inference inverts on low-frequency footage (smoke/fog/gradients): the encoder
  // wins its small size with long GOPs, so the file is small BECAUSE seeking it is expensive. And a skip
  // is not a soft loss — no `proxyUrl` means `preferNativeDecode`, which means the `<video>` element path,
  // which for a Flarex loader is a freeze. Measure the actual seek cost before skipping on size.
  // Probed lazily and once: files past the size gate transcode regardless, so they never pay for it.
  let gopProfile: GopProfile | null | undefined;
  const gop = async (): Promise<GopProfile | null> => {
    if (gopProfile === undefined) gopProfile = await probeGopProfile(blob);
    return gopProfile;
  };

  if (blob.size < MIN_SOURCE_BYTES) {
    const profile = await gop();
    if (!needsProxyForDecodeCost(profile)) {
      noteMeasuredDense(asset.id, profile);
      record(asset.id, "skipped", 0, `source small enough (${describeGopProfile(profile)})`);
      return null;
    }
    // Falls through to a real build. Deliberately NOT `record`ed — that would settle the asset as
    // "skipped" in the stats and the UI badge while the transcode is still running.
    logProxy(asset.id, `small but sparse GOP — building anyway (${describeGopProfile(profile)})`);
  }
  if (!sourceUrl) {
    record(asset.id, "skipped", 0, "no object url");
    return null;
  }

  const meta = await probeMetadata(sourceUrl);
  if (!meta) {
    record(asset.id, "skipped", 0, "metadata probe failed");
    return null;
  }
  if (meta.durationSeconds > MAX_SOURCE_DURATION_S) {
    record(asset.id, "skipped", 0, `too long (${Math.round(meta.durationSeconds)}s)`);
    return null;
  }
  // The notice's copy depends on this (see SourceProxyProgress.sourceHeight) — publish it as soon as
  // the probe answers, before any of the expensive work starts.
  if (progressAssetId === asset.id) progressSourceHeight = meta.height;
  const scale = Math.min(1, PROXY_LONG_EDGE / Math.max(meta.width, meta.height));
  if (scale >= 1 && blob.size < MIN_SOURCE_BYTES * 2) {
    // Already at/below proxy resolution and not huge — the original decodes fine, UNLESS its GOPs are
    // sparse. Resolution is only half of decode cost; a 720p source with 5-second GOPs still grinds a
    // whole GOP per seek. The transcode is worth it for the keyframe density alone even at scale 1.
    const profile = await gop();
    if (!needsProxyForDecodeCost(profile)) {
      noteMeasuredDense(asset.id, profile);
      record(asset.id, "skipped", 0, `already proxy-sized (${describeGopProfile(profile)})`);
      return null;
    }
    logProxy(asset.id, `proxy-sized but sparse GOP — rebuilding for keyframe density (${describeGopProfile(profile)})`);
  }
  const width = Math.max(2, Math.round((meta.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((meta.height * scale) / 2) * 2);

  // Past every skip/fast path — a real transcode is about to start (cold-origin UX signal).
  notifyFirstBuild();

  // Audio first (decodeAudioData is internally off-thread, and tells the muxer whether to open an
  // audio track at all). Decoded HERE because AudioContext can't run in a Worker; the PCM planes are
  // copied and transferred to the worker. The `arrayBuffer()` inside is a full-file copy — park it
  // behind the suspension gate and yield after, so an ingest burst never eats the copy cost while
  // the user is interacting (2026-07-18 "timeline froze during initial builds" report).
  await waitWhileSuspended();
  const audio = await decodeAudioTrack(blob);
  await yieldToMain();

  // WORKER-FIRST (2026-07-06): the decode→scale→encode body runs in sourceProxy.worker.ts so a build
  // can never hold the editor's main thread (root of the build-only playback freeze). Fall back to
  // the in-page loop below only for infrastructure failures — WebCodecs can't open the source inside
  // the worker (no <video> fallback there) or the worker chunk failed to boot. Deterministic build
  // failures (frozen-tail guard, no frames) rethrow: the fallback decodes through the same
  // WebCodecs-first path and would fail identically after doubling the work.
  // RESUME (2026-08-11, Slice 1/2): collect whatever guard-matching segments a previous interrupted
  // attempt left behind, in any order. Strictly best-effort — a miss just means a full rebuild,
  // which is exactly today's behaviour, so this can never make a build worse.
  const resume = await collectResumeSegments(asset.id, blob.size, width, height);
  const playheadSeconds = resolvePlayheadSeconds(asset.id);
  logProxy(asset.id, `playhead=${playheadSeconds === null ? "none (building from 0)" : `${playheadSeconds.toFixed(1)}s`}`);
  let encoded: TranscodeResult;
  try {
    encoded = await transcodeInWorker(asset, blob.size, sourceUrl, meta.durationSeconds, width, height, audio, resume, playheadSeconds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/WEBCODECS_REQUIRED_NO_DOM|WORKER_CRASHED/.test(message)) {
      throw error;
    }
    try {
      if (localStorage.getItem("orreris.perfLog") === "1") {
        console.info(`[source-proxy] ${asset.id}: worker unavailable (${message}) — main-thread fallback`);
      }
    } catch {
      /* ignore */
    }
    // The transferred PCM planes are detached now — re-decode audio for the fallback.
    encoded = await transcodeOnMainThread(sourceUrl, meta.durationSeconds, width, height, await decodeAudioTrack(blob));
  }
  const url = await saveSourceProxy(
    {
      assetId: asset.id,
      sourceByteSize: blob.size,
      width,
      height,
      durationSeconds: encoded.encodedFrames / encoded.fps,
      hasAudio: Boolean(audio),
    },
    encoded.blob
  );
  if (!url) {
    // The transcode SUCCEEDED — 15-89s of 4K work is already paid for and only the write failed.
    // Discarding it strands the clip on its 4K original for the whole session (a permanently frozen
    // preview), which is the worst of the available outcomes, so this is retryable. The cause now
    // travels with it: "quota exceeded" and "index write failed" are different problems and the
    // 2026-08-17 measurement could not tell them apart.
    throw new RetryableProxyPersistError(
      `proxy persist failed: ${lastSourceProxySaveError() ?? "cause not reported"}`
    );
  }
  // The COMPLETE proxy supersedes any partial one. Routing prefers `proxyUrl` unconditionally, so
  // adoption of the complete file is what actually retires the partial; this just releases the blob
  // (on a delay) and stops the engine offering it again.
  retirePartialProxy(asset.id);
  // The finished proxy supersedes its own resume cache — drop it so OPFS doesn't carry a second
  // copy of every proxy indefinitely. A failure here only wastes space; the guards still make the
  // stale segments unusable by any later build.
  void clearSourceProxySegments(asset.id);

  // DURATION HEAL (2026-07-13): the transcode just demuxed the source's TRUE decodable end. When
  // the stored asset duration overshoots it (legacy ceil-to-Int rows, stock provider metadata),
  // clips authored to that length freeze on their last frame for the overshoot — shrink the stored
  // duration (downward-only, server-enforced) so future adds/reloads use the real end. Fire and
  // forget: a failure just means the next build retries.
  const decodableEnd = encoded.decodableEndSeconds;
  if (decodableEnd !== undefined && decodableEnd > 0.2 && asset.durationSeconds - decodableEnd > 0.05) {
    void import("../../lib/api").then(({ healAssetDurationSeconds }) =>
      healAssetDurationSeconds(asset.id, decodableEnd).catch(() => undefined)
    );
  }
  return url;
}

/**
 * SEGMENT LENGTH, in frames. 300 rests on an UNFINISHED sweep — two clean single runs (300 vs 120)
 * plus the ~0.5% header-overhead argument; see `plans/source-proxy-progressive.md` §0b, which also
 * explains why the rest of that sweep is not trustworthy. A one-line change if it is ever redone.
 * Must be a multiple of PROXY_KEYFRAME_EVERY_N_FRAMES
 * so every segment boundary is a keyframe and a resume can splice there; the worker re-asserts it
 * and disables the cache rather than emit a prefix that would corrupt a rebuild.
 */
const PROXY_SEGMENT_FRAMES = PROXY_KEYFRAME_EVERY_N_FRAMES * 25; // 300 frames = 10s @30fps, 5s @60fps

interface ResumeSegment {
  index: number;
  buffer: ArrayBuffer;
}

/**
 * Collect every cached segment whose stamped guards match this asset's current bytes, recipe and
 * proxy dimensions. Any index, any gaps — playhead-first build order (Slice 2) persists the middle
 * of a clip before its head, so contiguity from 0 is no longer a precondition for reuse; the worker
 * simply encodes whatever is not here.
 *
 * A relinked, resized or recipe-bumped asset matches nothing and rebuilds from scratch, which is
 * exactly the behaviour that existed before any segment cache did.
 */
async function collectResumeSegments(
  assetId: string,
  sourceByteSize: number,
  width: number,
  height: number
): Promise<ResumeSegment[]> {
  const found: ResumeSegment[] = [];
  let frames = 0;
  try {
    for (const index of await listSourceProxySegmentIndices(assetId)) {
      const blob = await getSourceProxySegment(assetId, index);
      if (!blob) continue;
      const parsed = await decodeSegment(blob);
      if (!parsed) continue;
      const { header } = parsed;
      if (
        header.assetId !== assetId ||
        header.sourceByteSize !== sourceByteSize ||
        header.version !== SOURCE_PROXY_VERSION ||
        header.width !== width ||
        header.height !== height ||
        header.segmentIndex !== index ||
        header.startFrame !== index * PROXY_SEGMENT_FRAMES ||
        header.endFrame <= header.startFrame
      ) {
        continue;
      }
      found.push({ index, buffer: await blob.arrayBuffer() });
      frames += header.endFrame - header.startFrame;
    }
  } catch {
    return [];
  }
  if (found.length > 0) {
    logProxy(assetId, `resume cache: ${found.length} segment(s) [${found.map((s) => s.index).join(",")}], ${frames} frames already encoded`);
  }
  return found;
}

/**
 * PLAYHEAD-FIRST BUILD ORDER (2026-08-11, Slice 2). Where the user is parked in THIS asset's own
 * source timebase, or null when the asset is not under the playhead / nothing has registered.
 *
 * The engine deliberately does not compute this: mapping timeline time through a clip's
 * speed/sourceIn is the editor's knowledge, and duplicating it here would be a second copy of
 * `layerSourceTimeSeconds` to keep in sync. Builds only ever run while the transport is PARKED
 * (see setSourceProxyBuildSuspended), so this is a stationary reading, not a moving target.
 */
/**
 * PARTIAL PROXIES (2026-08-11, Slice 3). Fires while a build is still running, with a playable MP4
 * covering `[0, coverageSeconds)` of the source. The consumer stages it exactly like a finished
 * proxy — deferred to a parked transport — but into `partialProxyUrl`, and only layers whose whole
 * source range fits the coverage may route to it (`sourceProxyCoverage.ts`).
 *
 * Coverage only ever GROWS within a session: each emission strictly exceeds the last for that asset,
 * and the engine never retracts one. Withdrawing a proxy URL would bounce a source from the pooled
 * decoder onto the `<video>` element path, which is capped at ~16 hardware contexts.
 */
export interface SourceProxyPartial {
  assetId: string;
  url: string;
  coverageSeconds: number;
  segmentCount: number;
}
let partialListener: ((partial: SourceProxyPartial) => void) | null = null;
export function setSourceProxyPartialListener(listener: ((partial: SourceProxyPartial) => void) | null): void {
  partialListener = listener;
}

/** Per-asset partial-proxy state for THIS session: what we last published, so coverage only grows. */
interface PartialState {
  coverageSeconds: number;
  segmentCount: number;
  url: string;
  /** Superseded object URLs, revoked on a delay so a layer still holding one is never yanked. */
  retired: string[];
}
const partialPublished = new Map<string, PartialState>();

/**
 * Re-mux the cached prefix and publish it, if that is worth doing.
 *
 * RATE LIMIT: the mux copies the whole covered bitstream, so it is not run per completed segment.
 * `minGrowthSegments` is the caller's judgement about the moment — a build that has just STARTED on
 * top of an existing cache re-muxes immediately (that is the whole reopen-and-keep-working case),
 * while a build in flight waits for a meaningful jump.
 *
 * Entirely best-effort: every failure leaves the asset on whatever it is playing now, which is the
 * original — today's behaviour, and the fail-open rule this feature is not allowed to weaken.
 */
async function publishPartialProxy(assetId: string, sourceByteSize: number, minGrowthSegments: number): Promise<void> {
  if (!partialListener) return;
  const previous = partialPublished.get(assetId);
  try {
    const measured = await measurePrefixCoverage(assetId, sourceByteSize, PROXY_SEGMENT_FRAMES);
    if (!measured) return;
    if (previous && measured.segmentCount < previous.segmentCount + minGrowthSegments) return;
    if (previous && measured.segmentCount <= previous.segmentCount) return;
    const prefix = await buildPrefixProxy(assetId, sourceByteSize, PROXY_SEGMENT_FRAMES);
    if (!prefix) return;
    if (previous && prefix.coverageSeconds <= previous.coverageSeconds) return; // never shrink
    const url = URL.createObjectURL(prefix.blob);
    const retired = previous ? [...previous.retired, previous.url] : [];
    partialPublished.set(assetId, {
      coverageSeconds: prefix.coverageSeconds,
      segmentCount: prefix.segmentCount,
      url,
      retired: [],
    });
    logProxy(assetId, `partial proxy: ${prefix.segmentCount} segment(s), ${prefix.coverageSeconds.toFixed(1)}s playable`);
    partialListener({ assetId, url, coverageSeconds: prefix.coverageSeconds, segmentCount: prefix.segmentCount });
    // Revoke superseded blobs on a delay — a layer that resolved the old URL a moment ago may still
    // be mounting against it, and revoking underneath that is a black frame for no gain.
    if (retired.length > 0) {
      setTimeout(() => {
        for (const stale of retired) URL.revokeObjectURL(stale);
      }, 20_000);
    }
  } catch {
    /* a partial proxy is an optimization — never let it disturb the build */
  }
}

/**
 * Segments of coverage growth required before an IN-FLIGHT build re-muxes. The mux copies the whole
 * covered bitstream, so this trades freshness for main-thread work: 4 segments is 1,200 frames —
 * 40s of source at 30fps, 20s at 60 — which is a meaningful jump in what the user can actually
 * play, and caps the re-muxes on a 15-minute clip at single digits.
 */
const PARTIAL_REMUX_GROWTH_SEGMENTS = 4;
/** One publish at a time per asset: the mux is async and segment messages arrive far faster. */
const partialInFlight = new Set<string>();

function schedulePartialPublish(assetId: string, sourceByteSize: number, minGrowthSegments: number): void {
  if (!partialListener || partialInFlight.has(assetId)) return;
  partialInFlight.add(assetId);
  // On an idle window: this runs on the main thread while a build holds the worker, and the whole
  // point of the feature is that the editor stays usable meanwhile.
  whenIdle(() => {
    void publishPartialProxy(assetId, sourceByteSize, minGrowthSegments).finally(() => partialInFlight.delete(assetId));
  });
}

/** Drop this session's partial state for an asset (its complete proxy has landed, or it was reset). */
function retirePartialProxy(assetId: string): void {
  const state = partialPublished.get(assetId);
  if (!state) return;
  partialPublished.delete(assetId);
  // The complete proxy has already been adopted by the time this runs; still give any in-flight
  // render a grace period rather than revoking a URL a mounted layer might hold.
  setTimeout(() => {
    for (const url of [state.url, ...state.retired]) URL.revokeObjectURL(url);
  }, 20_000);
}

export type SourceProxyPlayheadResolver = (assetId: string) => number | null;
let playheadResolver: SourceProxyPlayheadResolver | null = null;
export function setSourceProxyPlayheadResolver(resolver: SourceProxyPlayheadResolver | null): void {
  playheadResolver = resolver;
}
function resolvePlayheadSeconds(assetId: string): number | null {
  if (!playheadResolver) return null;
  try {
    const seconds = playheadResolver(assetId);
    return seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  } catch {
    return null; // a resolver fault must never fail a build — fall back to building from 0
  }
}

interface TranscodeResult {
  blob: Blob;
  encodedFrames: number;
  fps: number;
  /** True decodable end from the source's sample table; undefined on the <video> fallback provider. */
  decodableEndSeconds?: number | undefined;
}

/** Run the transcode body in the dedicated worker; suspension changes are forwarded live. */
function transcodeInWorker(
  asset: SourceAsset,
  sourceByteSize: number,
  sourceUrl: string,
  durationSeconds: number,
  width: number,
  height: number,
  audio: DecodedAudio | null,
  resume: ResumeSegment[],
  playheadSeconds: number | null
): Promise<TranscodeResult> {
  return new Promise<TranscodeResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./sourceProxy.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(new Error(`WORKER_CRASHED: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const onSuspend = (suspended: boolean) =>
      worker.postMessage({ type: "suspend", suspended } satisfies SourceProxyWorkerRequest);
    suspendListeners.add(onSuspend);
    const cleanup = () => {
      suspendListeners.delete(onSuspend);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<SourceProxyWorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        reportProgress(message.encodedFrames, message.totalFrames);
        return; // NOT terminal — cleanup() here would terminate the worker mid-build
      }
      if (message.type === "segment") {
        // Persist the resume cache as it is produced. Fire-and-forget and best-effort: a segment
        // that fails to land costs a slower resume, never the build. Also NOT terminal.
        void saveSourceProxySegment(asset.id, message.segmentIndex, new Blob([message.buffer])).then(() =>
          // SLICE 3: once it is ON DISK, the prefix mux can read it. Rate-limited and idle-scheduled;
          // most calls return without muxing anything.
          schedulePartialPublish(asset.id, sourceByteSize, PARTIAL_REMUX_GROWTH_SEGMENTS)
        );
        return;
      }
      cleanup();
      if (message.type === "done") {
        resolve({
          blob: new Blob([message.buffer], { type: message.mime || "video/mp4" }),
          encodedFrames: message.encodedFrames,
          fps: message.fps,
          decodableEndSeconds: message.decodableEndSeconds,
        });
      } else if (message.retryable) {
        // The worker's encoder wedged and was reset. It cannot resume in place (out-of-order runs —
        // see its own note), so it hands the decision here: re-queue, bounded, and let the segment
        // cache make the rebuild cheap rather than settling the asset on its original for the session.
        reject(new RetryableProxyEncoderStallError(message.message || "source-proxy encoder stalled"));
      } else {
        reject(new Error(message.message || "source-proxy worker failed"));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(`WORKER_CRASHED: ${event.message || "source-proxy worker crashed"}`));
    };
    // Copy the PCM planes before transferring: getChannelData views alias the AudioBuffer's own
    // memory — transferring those buffers would detach the decoder's internals.
    const transfer: Transferable[] = [];
    let audioPayload: { sampleRate: number; channels: number; frames: number; planes: ArrayBuffer[] } | null = null;
    if (audio) {
      const planes = audio.planes.map((plane) => plane.slice().buffer as ArrayBuffer);
      audioPayload = { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, planes };
      transfer.push(...planes);
    }
    // Transfer the resume buffers rather than cloning them — a full-length cache is the size of the
    // finished proxy, and structured-cloning it would hold two copies across the postMessage.
    transfer.push(...resume.map((segment) => segment.buffer));
    worker.postMessage(
      {
        type: "start",
        payload: {
          assetId: asset.id,
          sourceByteSize,
          recipeVersion: SOURCE_PROXY_VERSION,
          sourceUrl,
          width,
          height,
          durationSeconds,
          maxFps: PROXY_FPS,
          keyFrameEveryNFrames: PROXY_KEYFRAME_EVERY_N_FRAMES,
          bitsPerPixelFrame: PROXY_BITS_PER_PIXEL_FRAME,
          audio: audioPayload,
          suspended: buildSuspended,
          segmentFrames: PROXY_SEGMENT_FRAMES,
          resumeSegments: resume,
          playheadSeconds,
        },
      } satisfies SourceProxyWorkerRequest,
      transfer
    );
  });
}

/** Main-thread fallback (sources the worker's WebCodecs path can't open). Same recipe + guards. */
async function transcodeOnMainThread(
  sourceUrl: string,
  durationSeconds: number,
  width: number,
  height: number,
  audio: DecodedAudio | null
): Promise<TranscodeResult> {
  // Software decode: never steal a hardware session from live playback.
  const provider = await createFrameProvider(sourceUrl, "video", { preferSoftware: true });
  // Sample at the SOURCE's own cadence (capped at PROXY_FPS): forcing 24fps content onto a hardcoded
  // 30fps grid duplicated every 4th frame — a visible judder/jerk the user caught by eye (2026-07-04).
  // At source fps every proxy frame maps 1:1 to a real source frame, and shorter sources need fewer
  // decode round-trips. Unknown cadence (the <video> fallback has no nominalFps) assumes 30 — NOT
  // the 60 cap, which would duplicate every frame of typical 30fps footage (recipe v7).
  const fps = Math.min(PROXY_FPS, provider.nominalFps ?? 30);
  const encoder = new MediaEncoder({
    width,
    height,
    fps,
    format: "mp4",
    // Sublinear fps scaling — same law as the worker path (recipe v7): 60fps ≈ √2× the 30fps size.
    videoBitrate: Math.round(width * height * fps * PROXY_BITS_PER_PIXEL_FRAME * Math.min(1, Math.sqrt(30 / fps))),
    // Frame-based GOP (keep in sync with the worker path): N frames → N/fps seconds, so the keyframe
    // cadence is fps-independent and high-fps proxies don't freeze the preview decoder.
    keyFrameIntervalSeconds: PROXY_KEYFRAME_EVERY_N_FRAMES / fps,
    audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels } : undefined,
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { desynchronized: true });
    if (!ctx) throw new Error("no 2d context for proxy scale");

    // FROZEN-TAIL GUARD: once the decoder fails mid-file (corrupt sample, decoder error) getFrame
    // returns null FOREVER — the old loop kept encoding the stale canvas, baking a video that plays
    // and then freezes into a photo INTO THE PROXY ITSELF (Venice soak, 2026-07-04: "played till
    // ~22s then stuck like a photo till the last"). A brief null gap (≤ ~0.5s) is tolerated as a
    // held frame; a longer run within the body of the clip ABORTS the build — no proxy at all beats
    // a corrupt proxy, playback simply keeps using the original. Nulls in the last quarter-second
    // (duration metadata often overshoots the sample table) end the encode cleanly instead.
    const maxNullRun = Math.max(2, Math.ceil(fps * 0.5));
    let nullRun = 0;
    let decodedAny = false;
    // DECODABLE-END CLAMP (2026-07-13, keep in sync with sourceProxy.worker.ts): asset duration
    // metadata can OVERSHOOT the sample table (historically up to ~1s via the ceil-to-Int asset
    // column). Past the last sample getFrame CLAMPS to the final frame — never null — so the
    // null-based frozen-tail guard below can't see it and the repeats bake into the proxy.
    // Clamp the frame loop to the demuxed truth instead of trusting the metadata.
    const decodableEnd = provider.decodableEndSeconds;
    const effectiveDuration =
      decodableEnd !== undefined && decodableEnd > 0.2 && decodableEnd < durationSeconds ? decodableEnd : durationSeconds;
    const frameCount = Math.max(1, Math.ceil(effectiveDuration * fps));
    let encodedFrames = 0;
    // Bounded, so a wedge that recurs on EVERY attempt settles as a stated failure instead of looping
    // forever — an unbounded retry on a genuinely broken asset is a new defect, not a fix. Matches the
    // encoder's own internal reset budget (2, `video-encoder.ts`), applied one level up.
    let stallResumes = 0;
    for (let i = 0; i < frameCount; i += 1) {
      // Parks an in-flight transcode within one frame when playback starts (see
      // setSourceProxyBuildSuspended); resumes exactly here on pause. The audio pre-decode is a
      // single non-interruptible decodeAudioData call — if play starts during it, it finishes
      // (sub-second) and the build parks at frame 0.
      await waitWhileSuspended();
      const frame = await provider.getFrame(i / fps);
      if (frame) {
        nullRun = 0;
        decodedAny = true;
        ctx.drawImage(frame as CanvasImageSource, 0, 0, width, height);
      } else {
        nullRun += 1;
        if (decodedAny && i / fps > effectiveDuration - 0.25) {
          // FROZEN-TAIL PROBE (debug only): the metadata duration overshoots the decodable sample
          // table — confirm the gap that leaves the timeline clip's tail with no real frames to serve.
          if (typeof window !== "undefined" && window.localStorage?.getItem("orreris.exportDecodeDebug") === "1") {
            console.warn(
              `[frozen-tail] proxy build: decodable content ends at ~${(i / fps).toFixed(3)}s but ` +
                `metadata duration is ${durationSeconds.toFixed(3)}s ` +
                `(overshoot ~${(durationSeconds - i / fps).toFixed(3)}s) — clip tail will freeze`
            );
          }
          break; // tail overshoot — finish with what we have
        }
        if (nullRun > maxNullRun) {
          throw new Error(`decoder stopped producing frames at ~${(i / fps).toFixed(1)}s — aborted (frozen-tail guard)`);
        }
      }
      try {
        await encoder.addVideoFrame(canvas, i);
      } catch (error) {
        if (error instanceof EncoderStallRecoveredError) {
          // The encoder wedged and was RESET; frames past `resumeFrameIndex` were queued but never
          // muxed. Rewind and re-decode/re-submit them — the same recovery `export-core.ts` performs,
          // deliberately mirrored rather than reinvented. Valid here because this path submits frames
          // strictly in order from 0, so the encoder's muxed-chunk count IS the next frame index (the
          // worker path cannot do this — see the note at its own `addVideoFrame`).
          //
          // Honouring `resumeFrameIndex` rather than restarting at 0 is the point: a restart would
          // silently convert a recoverable stall into a repeat of up to 15-89s of 4K transcode.
          // TERMINAL, deliberately: this path has already resumed in place twice. A third wedge is
          // evidence the encoder cannot finish THIS asset, so it settles as a stated failure rather
          // than handing the queue a fourth attempt at the same 4K transcode.
          if (stallResumes >= MAX_ENCODER_STALL_RESUMES) {
            throw new Error(
              `video encoder wedged ${stallResumes + 1}x (last resume at frame ${error.resumeFrameIndex} of ${frameCount}) — giving up on this build`
            );
          }
          stallResumes += 1;
          i = error.resumeFrameIndex - 1; // loop increment lands exactly on resumeFrameIndex
          encodedFrames = error.resumeFrameIndex; // frames [0, resumeFrameIndex) are muxed; the rest are not
          continue;
        }
        throw error;
      }
      encodedFrames += 1;
      if (encodedFrames % 30 === 0) {
        reportProgress(encodedFrames, frameCount); // same feedback contract as the worker path
      }
      // Yield after EVERY frame so the transcode never holds the main thread longer than one frame's
      // work — the user's clicks/scrubs interleave instead of waiting behind a batch. A longer
      // setTimeout breather every N frames additionally lets the browser do paint/GC.
      await yieldToMain();
      if (i % BREATHER_EVERY_FRAMES === 0) {
        await new Promise((resolve) => setTimeout(resolve, BREATHER_MS));
      }
    }
    if (!decodedAny) {
      throw new Error("decoder produced no frames — aborted");
    }
    if (audio) {
      await feedAudio(encoder, audio);
    }
    const proxyBlob = await encoder.finalize();
    return { blob: proxyBlob, encodedFrames, fps, decodableEndSeconds: decodableEnd };
  } catch (error) {
    encoder.dispose();
    throw error;
  } finally {
    provider.dispose();
  }
}

async function probeMetadata(url: string): Promise<{ width: number; height: number; durationSeconds: number } | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("metadata timeout")), 15_000);
      video.addEventListener(
        "loadedmetadata",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      video.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("metadata error"));
        },
        { once: true }
      );
    });
    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0) {
      return null;
    }
    return { width: video.videoWidth, height: video.videoHeight, durationSeconds: video.duration };
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

interface DecodedAudio {
  sampleRate: number;
  channels: number;
  planes: Float32Array[];
  frames: number;
}

/** Decode the source's audio track to 48k PCM (≤2 channels). Null = no usable audio. */
async function decodeAudioTrack(blob: Blob): Promise<DecodedAudio | null> {
  if (typeof OfflineAudioContext === "undefined") return null;
  try {
    const started = performance.now();
    const buffer = await new OfflineAudioContext(2, 1, 48_000).decodeAudioData(await blob.arrayBuffer());
    markHotSpot("source-proxy-audio-decode", started, `${Math.round(buffer.duration)}s`);
    if (!buffer.length) return null;
    const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
    const planes: Float32Array[] = [];
    for (let c = 0; c < channels; c += 1) {
      planes.push(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
    }
    return { sampleRate: buffer.sampleRate, channels, planes, frames: buffer.length };
  } catch {
    return null; // no audio track (or undecodable) — video-only proxy
  }
}

/**
 * Push the decoded PCM through the AAC encoder in planar chunks. ASYNC + yields every
 * AUDIO_YIELD_EVERY_CHUNKS: a 2-min clip is ~1600 chunks, and running them back-to-back froze the
 * main thread for ~1s per proxy (the "unknown" long tasks that correlated 1:1 with builds). Yielding
 * lets the user's input interleave so a background build never stutters the editor.
 */
async function feedAudio(encoder: MediaEncoder, audio: DecodedAudio): Promise<void> {
  const CHUNK = 4096;
  let chunkIndex = 0;
  for (let offset = 0; offset < audio.frames; offset += CHUNK) {
    const frames = Math.min(CHUNK, audio.frames - offset);
    const data = new Float32Array(frames * audio.channels);
    for (let c = 0; c < audio.channels; c += 1) {
      const plane = audio.planes[c];
      if (plane) data.set(plane.subarray(offset, offset + frames), c * frames);
    }
    encoder.encodeAudio(
      new AudioData({
        format: "f32-planar",
        sampleRate: audio.sampleRate,
        numberOfFrames: frames,
        numberOfChannels: audio.channels,
        timestamp: Math.round((offset / audio.sampleRate) * 1_000_000),
        data,
      })
    );
    if (++chunkIndex % AUDIO_YIELD_EVERY_CHUNKS === 0) {
      await yieldToMain();
    }
  }
}
