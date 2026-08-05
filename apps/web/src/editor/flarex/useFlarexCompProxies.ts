/**
 * Play a Flarex comp from its pre-rendered proxy instead of evaluating the graph (S2, preview half).
 *
 * The Edit page's counterpart to "Prepare proxy". For every `flarexCompId` clip this decides whether a
 * stored proxy may stand in, decodes it through the ordinary preview decoder pool, and publishes the
 * current frame into a ref the scene draw loop reads (`flarexCompProxiesRef` → `buildSceneDraws`).
 *
 * WHY THIS IS THE WIN. A comp with N asset-source MediaIns decodes N streams against ~4 pooled
 * decoders, which is why its sources visibly converge at different times when you pause or play. A
 * proxy collapses that to ONE stream, so there is nothing left to stagger — on top of skipping the
 * per-frame graph evaluation entirely.
 *
 * FOUR GUARDS, all failing open to today's live evaluation:
 *   1. Key match — the stored proxy must have been rendered under the comp's CURRENT identity. Any node
 *      edit bumps `comp.version`; any clip edit changes the host signature. This is the whole "is it
 *      dirty?" question, and it is answered by the key rather than by a flag anyone has to maintain.
 *   2. Opacity safety — `canSubstituteFlarexProxy`. A rendered proxy bakes the composition background,
 *      so it may only replace a clip with nothing drawn beneath it.
 *   3. Live graph on the Flarex page — building a comp must always show the real thing.
 *   4. `?flarexProxy=0` kill switch, matching the `?wcDecode=0|1` doctrine.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FlarexCompProxyFrame, FlarexComp, TimelineComposition, TimelineLayer } from "@orreris/shared";
import { acquirePreviewFrameProvider, type PreviewFrameLease } from "../../playback/preview-frame-pool";
import { getLivePlaybackTime } from "../../playback/playback-clock";
import type { FrameProvider } from "../../export/source-decoder";
import { flarexCompProxyIdentity, flarexCompProxyKey } from "./flarex-comp-proxy";
import { canSubstituteFlarexProxy } from "./flarex-proxy-eligibility";
import { getFlarexCompProxy, subscribeFlarexProxyStore } from "./flarex-comp-proxy-store";
import { setFlarexProxyServing } from "./flarex-proxy-status";
import { defaultSession, holdDecoderSession, releaseDecoderHold, servedTime, type ServedTime } from "@orreris/shared";

/**
 * The moment a delivered proxy frame actually represents (ADR-012 T5/T7, slice S4.2).
 *
 * `VideoFrame.timestamp` is microseconds in the source's own timebase, which for a comp proxy is
 * comp-local seconds — the same basis as the `localT` the pump asks with, so the two are directly
 * comparable and the barrier in S4.4 needs no conversion.
 *
 * A spreadable partial so that "cannot say" stays ABSENT rather than becoming `servedTime: undefined`:
 * under `exactOptionalPropertyTypes` those differ, and the difference is the point — an unknowable time
 * must never be readable as a current one.
 */
function proxyServedTime(frame: unknown): { servedTime?: ServedTime } {
  if (typeof VideoFrame === "undefined" || !(frame instanceof VideoFrame)) return {};
  const seconds = frame.timestamp / 1_000_000;
  return Number.isFinite(seconds) ? { servedTime: servedTime(seconds) } : {};
}

/** `?flarexProxy=0` disables playback substitution outright (proxies can still be rendered/stored). */
function proxyPlaybackEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("flarexProxy") !== "0";
  } catch {
    return true;
  }
}

interface ActiveProxy {
  compId: string;
  key: string;
  /** Comp-local time = transport time − this. */
  hostStartSeconds: number;
  hostDurationSeconds: number;
  objectUrl: string;
  lease: PreviewFrameLease;
  provider: FrameProvider | null;
  busy: boolean;
  /** Bumped per presented frame so the compositor can skip an unchanged texture upload. */
  version: number;
  /**
   * Latest time requested while a decode was already in flight, replayed when it lands.
   *
   * Without this the request was simply DROPPED, and a single-shot seek could leave the comp on a
   * stale frame forever: a ruler CLICK pumps `requestFrames` exactly once, so if that one call arrived
   * while the decoder was busy there was no second attempt and nothing else to retrigger it. Dragging
   * hid the bug — a scrub pumps continuously, so a later call always got through — which is why this
   * read as "seeking updates the media but clicking does not", and only for comp proxies (every other
   * media layer is clock-driven and never queues behind a decode).
   */
  pendingTime: number | null;
  /**
   * OUR clone of the presented frame, owned by us and closed when the next one replaces it.
   *
   * `getFrame` returns a frame the PROVIDER owns and closes on its next call. Holding that reference and
   * then requesting the next frame hands the compositor a closed VideoFrame to upload — which is why the
   * proxy ran at ~40fps while the identical file imported as an ordinary clip ran at 60, with the
   * profiler reporting only ~2ms GPU: nothing was slow, frames were being thrown away. Every other
   * consumer here clones for exactly this reason (see WebglMediaLayer's presentFrame).
   */
  held: VideoFrame | null;
  /**
   * SUSPENDED since this wall-clock ms, or null while SERVING (ADR-012 5.12, slice S3.5).
   *
   * The proxy state machine is `… → SERVING → SUSPENDED → SERVING`, and the ADR calls `SUSPENDED`
   * mandatory: *a proxy must relinquish gradually, with its sources warm, before it stops serving.*
   * Before this, losing eligibility went straight to teardown — lease released, object URL revoked — so
   * a comp that briefly stopped qualifying paid a full re-demux and re-index to come back.
   *
   * Eligibility is not a stable property. It depends on `canSubstituteFlarexProxy`, which reads the
   * z-order: anything drawn beneath the clip disqualifies it. So dragging a layer under a proxied clip
   * and back out, or a transient during a reorder, is an ordinary edit that used to destroy a decoder.
   *
   * A KEY change is different and is still an immediate teardown, deliberately: that is `INVALID`, not
   * `SUSPENDED` — the comp was edited, and a stale frame must never survive an edit.
   */
  suspendedSince: number | null;
  /** The bounded relinquish timer. Cleared on resume; fires the real teardown on expiry (I-31). */
  suspendTimer: number | null;
}

/**
 * How long a proxy may sit SUSPENDED before it is really let go.
 *
 * Bounded for the same reason every other wait in this runtime is (I-31): a comp can stop being eligible
 * and never come back, and an unbounded suspension would pin a decode session and a blob for the rest of
 * the session. Two seconds covers the edit-shaped causes — a reorder, a drag over and back — without
 * holding a slot through anything a user would experience as a decision.
 */
const PROXY_SUSPEND_MS = 2_000;

/**
 * `window.__rfFlarexProxy` — which decode path each comp proxy actually got, and how it is doing.
 *
 * `__rfWcMode` only covers layers that go through `WebglMediaLayer`, so a comp proxy was invisible to
 * every existing probe. That blind spot cost two wrong diagnoses: a webm proxy silently fell back to a
 * seek-per-frame `<video>` and nothing anywhere said so. `mode` is read from the provider itself —
 * `__wcDecodeCalls` exists only on the WebCodecs provider, so `element` here means the mp4box demux
 * failed and `createFrameProvider` fell through.
 */
function recordProxyStat(compId: string, patch: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __rfFlarexProxy?: Record<string, Record<string, unknown>> };
  const stats = (w.__rfFlarexProxy ??= {});
  stats[compId] = { ...(stats[compId] ?? {}), ...patch };
}

/** Per-comp decode/null tallies backing `__rfFlarexProxy` (module-scoped: telemetry, not state). */
const proxyDecodes = new Map<string, number>();
const proxyNulls = new Map<string, number>();

/** Close a held clone if it is one. Frames from an `<video>`/image provider are not VideoFrames. */
function closeHeld(active: { held: VideoFrame | null }): void {
  if (!active.held) return;
  try {
    active.held.close();
  } catch {
    /* already closed */
  }
  active.held = null;
}

export interface UseFlarexCompProxiesInput {
  composition: TimelineComposition | undefined;
  flarexComps: Record<string, FlarexComp> | undefined;
  /** The BACK-TO-FRONT layer list the draw builder consumes — the same z-order eligibility reads. */
  zOrderedLayers: readonly TimelineLayer[];
  /** False on the Flarex page: building a comp must always show the live graph. */
  enabled: boolean;
  /** Transport state. While playing the decoder is pumped from the LIVE clock, not the committed one. */
  isPlaying: boolean;
  /** Ask the scene canvas to repaint once a newly decoded frame has been published. */
  requestRedraw: () => void;
}

export interface UseFlarexCompProxiesResult {
  /** Read live by the draw loop; empty when nothing is substituted. */
  framesRef: React.MutableRefObject<Record<string, FlarexCompProxyFrame>>;
  /**
   * Comps actually PRESENTING proxy frames right now — reactive, so the caller can stop mounting their
   * asset-source loaders.
   *
   * This is load-bearing, not diagnostics. Short-circuiting the compiler does NOT stop the comp's
   * MediaIn decoders: the virtual loaders are still built and still mount a decoder each, so a
   * substituted comp decodes N source streams PLUS the proxy — strictly more work than not proxying at
   * all (user report: 75fps → 35-40fps). The whole win depends on those loaders going away.
   *
   * Deliberately flipped by the FIRST PRESENTED FRAME rather than by eligibility: between acquiring a
   * decoder and its first frame there is nothing to draw, and unmounting the loaders early would make
   * every MediaIn soft-degrade to the host clip for that window — a visible wrong picture.
   */
  servingCompIds: readonly string[];
  /** Pump the decoders for `timeSeconds`. Call once per preview frame. */
  requestFrames: (timeSeconds: number) => void;
}

export function useFlarexCompProxies(input: UseFlarexCompProxiesInput): UseFlarexCompProxiesResult {
  const { composition, flarexComps, zOrderedLayers, enabled, isPlaying, requestRedraw } = input;
  const framesRef = useRef<Record<string, FlarexCompProxyFrame>>({});
  const activeRef = useRef<Map<string, ActiveProxy>>(new Map());
  const [servingCompIds, setServingCompIds] = useState<readonly string[]>([]);
  // `requestFrames` is ref-frozen at mount, so transport state has to reach it through a ref.
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  /**
   * Keys whose proxy exists but **cannot be served** — the pool refused a lease, or the decoder failed
   * to init. Permanent for the page: retried only when the KEY changes, i.e. after a re-render.
   *
   * Without this, a failing key is re-attempted on every eligibility recompute: acquire a pooled session,
   * fail init, release, repeat — burning one of only 4 sessions in a loop while the comp's real sources
   * compete for the rest. Bounded here rather than in the pool, because "this exact file can't be served"
   * is knowledge only this caller has.
   */
  const unservableKeysRef = useRef<Set<string>>(new Set());
  /**
   * Keys we looked up and found **nothing stored for**. A different fact from the one above, and
   * conflating the two was a real bug (soak, 2026-08-02).
   *
   * "No proxy under this key" is not a failure and costs no decoder session — `getFlarexCompProxy`
   * returns undefined and we bail long before `acquirePreviewFrameProvider`. The loop the set above
   * guards against cannot happen here. What memoizing it permanently DID do was make the most ordinary
   * sequence unrecoverable: open the Edit page (nothing stored → memoized missing), press Prepare
   * proxy (stored under the SAME key, because the key is the comp's identity and preparing a proxy
   * does not change it), and substitution never engaged until a reload.
   *
   * Cleared on any store write — see `subscribeFlarexProxyStore`. Positive lookups need no such
   * invalidation: their key changes whenever the comp does.
   */
  const missingKeysRef = useRef<Set<string>>(new Set());
  /** Bumped by a store write so the reconcile effect re-runs and re-checks the missing keys. */
  const [storeTick, setStoreTick] = useState(0);
  useEffect(
    () =>
      subscribeFlarexProxyStore(() => {
        missingKeysRef.current.clear();
        setStoreTick((tick) => tick + 1);
      }),
    []
  );

  const setServing = useCallback((compId: string, serving: boolean) => {
    setServingCompIds((current) => {
      const has = current.includes(compId);
      if (has === serving) return current; // identity-stable: no re-render, no loader churn
      return serving ? [...current, compId] : current.filter((id) => id !== compId);
    });
  }, []);

  // Which comps are ELIGIBLE right now, and under which key. Recomputed whenever the comps, the
  // timeline or the composition change — which is exactly when a key can go stale, so a dirty comp
  // stops being eligible on the same render that dirtied it.
  const eligible = useMemo(() => {
    if (!enabled || !composition || !flarexComps || !proxyPlaybackEnabled()) return [];
    const fps = Math.max(1, composition.fps || 30);
    const out: Array<{ compId: string; key: string; hostStartSeconds: number; hostDurationSeconds: number }> = [];
    for (const layer of zOrderedLayers) {
      if (!layer.flarexCompId) continue;
      const comp = flarexComps[layer.flarexCompId];
      if (!comp) continue;
      // A proxy bakes the background, so it may only stand in where nothing is drawn below.
      if (!canSubstituteFlarexProxy(zOrderedLayers, layer)) continue;
      out.push({
        compId: comp.id,
        key: flarexCompProxyKey(flarexCompProxyIdentity(composition, comp, layer, fps)),
        hostStartSeconds: layer.startSeconds,
        hostDurationSeconds: layer.durationSeconds,
      });
    }
    return out;
  }, [enabled, composition, flarexComps, zOrderedLayers]);

  // Reconcile decoders against the eligible set. A comp whose key changed is torn down and (if a proxy
  // exists under the NEW key) rebuilt, so a stale frame can never survive an edit.
  useEffect(() => {
    let cancelled = false;
    const wanted = new Map(eligible.map((entry) => [entry.compId, entry]));

    for (const [compId, active] of activeRef.current) {
      const next = wanted.get(compId);
      if (next && next.key === active.key) {
        // RESUME (S3.5). Eligible again under the same key while suspended — nothing was destroyed, so
        // this is a flag flip rather than an acquisition. `setServing` stays false until a frame is
        // actually presented again, which is the same rule the first-frame flip already follows.
        if (active.suspendedSince !== null) {
          if (active.suspendTimer !== null) window.clearTimeout(active.suspendTimer);
          active.suspendTimer = null;
          active.suspendedSince = null;
        }
        continue;
      }
      // INVALID — the comp was edited, so the stored frames are for a different picture. Immediate,
      // never suspended: a stale frame must not survive an edit.
      const invalid = next != null && next.key !== active.key;
      if (invalid) {
        activeRef.current.delete(compId);
        delete framesRef.current[compId];
        closeHeld(active);
        if (active.suspendTimer !== null) window.clearTimeout(active.suspendTimer);
        // Loaders must come back BEFORE the proxy stops drawing, or the comp has no sources for a frame.
        setServing(compId, false);
        active.lease.release();
        releaseDecoderHold(defaultSession, active.objectUrl);
        URL.revokeObjectURL(active.objectUrl);
        continue;
      }
      // SUSPENDED — ineligible, but the decoder and the blob are kept for a bounded window. The comp
      // goes back to its live graph immediately (the loaders were never unmounted under S3.5, so they
      // are warm and already pulling again), and coming back costs nothing.
      if (active.suspendedSince !== null) continue;
      active.suspendedSince = Date.now();
      delete framesRef.current[compId];
      closeHeld(active);
      active.version = 0; // a resume presents a first frame again
      setServing(compId, false);
      requestRedraw();
      active.suspendTimer = window.setTimeout(() => {
        const current = activeRef.current.get(compId);
        if (current !== active || active.suspendedSince === null) return;
        activeRef.current.delete(compId);
        delete framesRef.current[compId];
        closeHeld(active);
        active.lease.release();
        releaseDecoderHold(defaultSession, active.objectUrl);
        URL.revokeObjectURL(active.objectUrl);
      }, PROXY_SUSPEND_MS);
    }

    for (const entry of eligible) {
      if (activeRef.current.has(entry.compId) || unservableKeysRef.current.has(entry.key)) continue;
      if (missingKeysRef.current.has(entry.key)) continue;
      void (async () => {
        const stored = await getFlarexCompProxy(entry.compId, entry.key);
        // No proxy under this key — the comp was edited since it was built, or never had one. Live.
        if (!stored || cancelled) {
          if (!stored) missingKeysRef.current.add(entry.key);
          return;
        }
        const objectUrl = URL.createObjectURL(stored.blob);
        // DECLARED INTENT (S4.7): comp-local seconds, the same basis `pumpOne` requests in. A comp proxy
        // has a freshly-minted blob URL, so it never actually borrows — no other consumer can hold that
        // key. Declared anyway rather than left undefined, because "this caller cannot say" and "this
        // caller happens never to collide" are different claims and only one of them is true here.
        const lease = acquirePreviewFrameProvider(objectUrl, {
          priority: "playhead",
          // DECLARED PURPOSE (C15). A comp proxy is serving the LIVE picture — it stands in for the
          // comp's own sources in the frame the user is watching, so it competes as live work and not
          // as background. Building a proxy would be background; SERVING one is not. Recorded only.
          purpose: "live",
          requestedTime: Math.max(0, getLivePlaybackTime() - entry.hostStartSeconds),
        });
        if (!lease) {
          // Pool is full. The comp's own sources will take those slots instead — no worse than today.
          unservableKeysRef.current.add(entry.key);
          URL.revokeObjectURL(objectUrl);
          return;
        }
        const active: ActiveProxy = {
          compId: entry.compId,
          key: entry.key,
          hostStartSeconds: entry.hostStartSeconds,
          hostDurationSeconds: entry.hostDurationSeconds,
          objectUrl,
          lease,
          provider: null,
          busy: false,
          pendingTime: null,
          version: 0,
          held: null,
          suspendedSince: null,
          suspendTimer: null,
        };
        activeRef.current.set(entry.compId, active);
        // DECODER MANAGER (S3.5 amendment): a comp proxy holds a real session that no declared source
        // backs. Saying so here is what stops the ledger reading every proxy as a leaked session.
        holdDecoderSession(defaultSession, objectUrl, `comp-proxy:${entry.compId}`);
        const provider = await lease.ready;
        if (cancelled || activeRef.current.get(entry.compId) !== active) return;
        if (!provider) {
          // Decoder init failed — drop back to live evaluation rather than showing nothing, and don't
          // re-attempt this exact file (see unservableKeysRef).
          unservableKeysRef.current.add(entry.key);
          activeRef.current.delete(entry.compId);
          closeHeld(active);
          lease.release();
          releaseDecoderHold(defaultSession, objectUrl);
          URL.revokeObjectURL(objectUrl);
          return;
        }
        active.provider = provider;
        // `__wcDecodeCalls` is defined only on the WebCodecs provider — its absence means mp4box could
        // not demux this file and `createFrameProvider` fell through to a seek-per-frame <video>.
        recordProxyStat(entry.compId, {
          mode: "__wcDecodeCalls" in (provider as object) ? "webcodecs" : "element",
          mime: stored.blob.type,
          bytes: stored.blob.size,
          size: `${provider.width}x${provider.height}`,
          decodes: 0,
          nulls: 0,
        });
        requestRedraw();
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [eligible, requestRedraw, setServing, storeTick]);

  // Publish for the timeline's clip badge. `servingCompIds` is identity-stable unless it really
  // changed (see setServing), so this is a no-op on ordinary renders.
  useEffect(() => {
    setFlarexProxyServing(servingCompIds);
  }, [servingCompIds]);
  useEffect(() => () => setFlarexProxyServing([]), []);

  // Full teardown on unmount — leases pin real decoder sessions and object URLs pin the blobs.
  useEffect(
    () => () => {
      for (const active of activeRef.current.values()) {
        if (active.suspendTimer !== null) window.clearTimeout(active.suspendTimer);
        closeHeld(active);
        active.lease.release();
        releaseDecoderHold(defaultSession, active.objectUrl);
        URL.revokeObjectURL(active.objectUrl);
      }
      activeRef.current.clear();
      framesRef.current = {};
      setServingCompIds([]);
    },
    []
  );

  /** Replay the newest time that arrived mid-decode — this is what makes "latest time wins" true. */
  const drainPending = useRef((active: ActiveProxy) => {
    const next = active.pendingTime;
    if (next === null) return;
    active.pendingTime = null;
    pumpOne.current(active, next);
  }).current;

  const pumpOne = useRef((active: ActiveProxy, timeSeconds: number) => {
      const provider = active.provider;
      if (!provider) return;
      // A SUSPENDED proxy holds its decoder and decodes nothing (S3.5). Pumping here would keep
      // publishing frames for a comp that is no longer entitled to be substituted — the substitution
      // outliving its own eligibility, which is the I-25 half of what this state exists to prevent.
      if (active.suspendedSince !== null) return;
      // One in-flight decode per comp, LATEST TIME WINS — remembered, not discarded.
      if (active.busy) {
        active.pendingTime = timeSeconds;
        return;
      }
      const localT = timeSeconds - active.hostStartSeconds;
      // Outside the host clip's span the comp is not on screen; drop the frame so a stale one can't be
      // drawn if the clip comes back into range.
      if (localT < 0 || localT >= active.hostDurationSeconds) {
        if (framesRef.current[active.compId]) {
          delete framesRef.current[active.compId];
          closeHeld(active);
          active.version = 0; // next re-entry counts as a first frame again
          setServing(active.compId, false);
          requestRedraw();
        }
        return;
      }
      active.busy = true;
      void provider
        .getFrame(localT)
        .then((frame) => {
          active.busy = false;
          // Stale entry (comp swapped out mid-decode) — do NOT drain: this active is finished with.
          if (activeRef.current.get(active.compId) !== active) return;
          // SUSPENDED mid-decode (S3.5). A suspended active is deliberately still in the map — that is
          // what keeps its decoder — so the identity check above passes and this frame would be
          // published for a comp that has just lost the right to be substituted, flipping `setServing`
          // back on behind it. The substitution outliving its own eligibility is exactly the I-25
          // failure `SUSPENDED` exists to prevent, and the request/response gap is the only place it
          // can happen. Dropped, not drained: the pending time is for a state we are no longer in.
          if (active.suspendedSince !== null) {
            active.pendingTime = null;
            return;
          }
          if (!frame) {
            proxyNulls.set(active.compId, (proxyNulls.get(active.compId) ?? 0) + 1);
            recordProxyStat(active.compId, { nulls: proxyNulls.get(active.compId) });
            drainPending(active);
            return;
          }
          proxyDecodes.set(active.compId, (proxyDecodes.get(active.compId) ?? 0) + 1);
          recordProxyStat(active.compId, { decodes: proxyDecodes.get(active.compId) });
          // Clone before holding — the provider closes its original on the NEXT getFrame, which we are
          // about to issue. Close the previous clone in the same step so exactly one frame per comp is
          // ever outstanding (an unclosed VideoFrame also back-pressures the decoder).
          let held: FlarexCompProxyFrame["source"] = frame as FlarexCompProxyFrame["source"];
          if (typeof VideoFrame !== "undefined" && frame instanceof VideoFrame) {
            try {
              const clone = frame.clone();
              closeHeld(active);
              active.held = clone;
              held = clone;
            } catch {
              held = frame as FlarexCompProxyFrame["source"]; // clone failed — better a stale ref than none
            }
          }
          active.version += 1;
          framesRef.current[active.compId] = {
            source: held,
            sourceWidth: provider.width,
            sourceHeight: provider.height,
            sourceVersion: active.version,
            // ADR-012 T7, slice S4.2 — "a proxy is a source; it carries a time". Until now this was the
            // one participant standing in for a whole comp that a coherence check could not evaluate:
            // it had a version and no time, so it could be arbitrarily behind the playhead and still
            // read as ready, because there was nothing to read.
            //
            // Taken from the DELIVERED frame's own timestamp, never from `localT`. `localT` is what we
            // ASKED for; a decoder answers with the nearest frame it has, and treating the request as
            // the answer is exactly the conflation this slice exists to remove — it would make every
            // proxy frame report perfect coherence by construction. Comparable to `localT` without
            // conversion because a comp proxy is an mp4 of the comp's own span, so its timebase IS
            // comp-local seconds. Absent (not zero) when the source is not a `VideoFrame` and cannot
            // say — "unknowable" must never be readable as "current".
            ...proxyServedTime(frame),
          };
          // First frame for this comp → its asset-source loaders can stop decoding (see servingCompIds).
          if (active.version === 1) setServing(active.compId, true);
          // While PLAYING the scene already recomposites every frame, so asking for another one here is
          // a duplicate composite per decoded frame — real GPU cost on exactly the path we are trying to
          // make cheaper. Paused, this redraw IS what puts the frame on screen.
          if (!isPlayingRef.current) requestRedraw();
          drainPending(active);
        })
        .catch(() => {
          active.busy = false;
          if (activeRef.current.get(active.compId) === active) drainPending(active);
        });
  });

  const requestFrames = useRef((timeSeconds: number) => {
    for (const active of activeRef.current.values()) pumpOne.current(active, timeSeconds);
  }).current;

  /**
   * PLAYBACK PUMP. While playing, drive the decoder from its own rAF loop reading
   * `getLivePlaybackTime()` — NOT from the `currentTime` prop.
   *
   * `currentTime` is the COMMITTED clock, advanced once per `playbackCommitIntervalMs` (16/40/90ms by
   * preview quality). Requesting frames on it caps the proxy at the commit rate — ~11Hz on the
   * performance tier — so the comp visibly stutters while every other layer runs smooth. This is the
   * same trap the Flarex frame ruler fell into (2026-07-26) and the reason every media layer rides the
   * live, anchor-derived clock during playback.
   *
   * Paused, the committed clock IS the truth (seeks are discrete), so the `currentTime` effect in the
   * caller covers scrubbing and this loop stays off.
   */
  useEffect(() => {
    if (!isPlaying || activeRef.current.size === 0) return undefined;
    let raf = 0;
    const tick = () => {
      requestFrames(getLivePlaybackTime());
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [isPlaying, eligible, requestFrames]);

  return { framesRef, servingCompIds, requestFrames };
}
