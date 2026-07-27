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
          version: 0,
        };
        activeRef.current.set(entry.compId, active);
        const provider = await lease.ready;
        if (cancelled || activeRef.current.get(entry.compId) !== active) return;
        if (!provider) {
          // Decoder init failed — drop back to live evaluation rather than showing nothing, and don't
          // re-attempt this exact file (see failedKeysRef).
          failedKeysRef.current.add(entry.key);
          activeRef.current.delete(entry.compId);
          lease.release();
          URL.revokeObjectURL(objectUrl);
          return;
        }
        active.provider = provider;
        requestRedraw();
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [eligible, requestRedraw, setServing]);

  // Full teardown on unmount — leases pin real decoder sessions and object URLs pin the blobs.
  useEffect(
    () => () => {
      for (const active of activeRef.current.values()) {
        active.lease.release();
        URL.revokeObjectURL(active.objectUrl);
      }
      activeRef.current.clear();
      framesRef.current = {};
      setServingCompIds([]);
    },
    []
  );

  const requestFrames = useRef((timeSeconds: number) => {
    for (const active of activeRef.current.values()) {
      const provider = active.provider;
      if (!provider || active.busy) continue; // one in-flight decode per comp, latest time wins
      const localT = timeSeconds - active.hostStartSeconds;
      // Outside the host clip's span the comp is not on screen; drop the frame so a stale one can't be
      // drawn if the clip comes back into range.
      if (localT < 0 || localT >= active.hostDurationSeconds) {
        if (framesRef.current[active.compId]) {
          delete framesRef.current[active.compId];
          active.version = 0; // next re-entry counts as a first frame again
          setServing(active.compId, false);
          requestRedraw();
        }
        continue;
      }
      active.busy = true;
      void provider
        .getFrame(localT)
        .then((frame) => {
          active.busy = false;
          if (!frame || activeRef.current.get(active.compId) !== active) return;
          active.version += 1;
          framesRef.current[active.compId] = {
            source: frame as FlarexCompProxyFrame["source"],
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
        })
        .catch(() => {
          active.busy = false;
        });
    }
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
