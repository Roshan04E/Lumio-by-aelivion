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
import { getFlarexCompProxy } from "./flarex-comp-proxy-store";
import { setFlarexProxyServing } from "./flarex-proxy-status";

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
}

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
   * Keys whose proxy could not be turned into a decoder (missing blob, pool full, init failed). Retried
   * only when the KEY changes, i.e. after a re-render of the proxy.
   *
   * Without this, a failing key is re-attempted on every eligibility recompute: acquire a pooled session,
   * fail init, release, repeat — burning one of only 4 sessions in a loop while the comp's real sources
   * compete for the rest. Bounded here rather than in the pool, because "this exact file can't be served"
   * is knowledge only this caller has.
   */
  const failedKeysRef = useRef<Set<string>>(new Set());

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
      if (next && next.key === active.key) continue;
      activeRef.current.delete(compId);
      delete framesRef.current[compId];
      closeHeld(active);
      // Loaders must come back BEFORE the proxy stops drawing, or the comp has no sources for a frame.
      setServing(compId, false);
      active.lease.release();
      URL.revokeObjectURL(active.objectUrl);
    }

    for (const entry of eligible) {
      if (activeRef.current.has(entry.compId) || failedKeysRef.current.has(entry.key)) continue;
      void (async () => {
        const stored = await getFlarexCompProxy(entry.compId, entry.key);
        // No proxy under this key — the comp was edited since it was built, or never had one. Live.
        if (!stored || cancelled) {
          if (!stored) failedKeysRef.current.add(entry.key);
          return;
        }
        const objectUrl = URL.createObjectURL(stored.blob);
        const lease = acquirePreviewFrameProvider(objectUrl, { priority: "playhead" });
        if (!lease) {
          // Pool is full. The comp's own sources will take those slots instead — no worse than today.
          failedKeysRef.current.add(entry.key);
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
        };
        activeRef.current.set(entry.compId, active);
        const provider = await lease.ready;
        if (cancelled || activeRef.current.get(entry.compId) !== active) return;
        if (!provider) {
          // Decoder init failed — drop back to live evaluation rather than showing nothing, and don't
          // re-attempt this exact file (see failedKeysRef).
          failedKeysRef.current.add(entry.key);
          activeRef.current.delete(entry.compId);
          closeHeld(active);
          lease.release();
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
  }, [eligible, requestRedraw, setServing]);

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
        closeHeld(active);
        active.lease.release();
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
