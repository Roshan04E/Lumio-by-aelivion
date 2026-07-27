/**
 * Flarex comp proxy — render + identity (plans/flarex-comp-proxy.md, S1).
 *
 * A comp proxy is Fusion's render cache: the host clip's node graph rendered ONCE to a media file, so
 * the Edit page can play it back as ordinary media instead of lowering + evaluating the graph every
 * frame. This module owns two things — what a proxy's IDENTITY is (the key), and how one is RENDERED.
 * Persistence lives in [flarex-comp-proxy-store.ts]; playback substitution is S2 and does not exist yet.
 *
 * Rendering is assembly, not new machinery: `generateSpanProxy` already renders a span of a composition
 * through the export Worker's single WebGL2 context (with a main-thread fallback and a black-frame
 * guard), and `runExportCore` already lowers `flarexCompId` clips + decodes their asset-source loaders.
 * All this adds is the right composition to hand it.
 *
 * TWO INVARIANTS, both load-bearing:
 *
 *  - **Never authoritative.** A proxy is a PLAYBACK optimization. Export must always re-render from the
 *    graph — the render manifest is the product contract (CLAUDE.md) and a cached media file is a lossy
 *    derivative. Nothing here is reachable from `buildRenderManifest` or the export path, and it must
 *    stay that way.
 *  - **Fail open.** No proxy, a stale key, a decode failure ⇒ today's live evaluation, silently.
 */

import {
  collectFlarexSourceAssetIds,
  type FlarexComp,
  type SourceAsset,
  type TimelineComposition,
  type TimelineLayer,
} from "@orreris/shared";
import type { FlarexSourceAssetMap } from "../../export/export-core";
import { generateSpanProxy, ProxyGenerationAborted } from "../performance/proxyWorkerClient";
import { putFlarexCompProxy, type StoredFlarexCompProxy } from "./flarex-comp-proxy-store";

/**
 * Everything a rendered proxy is a function of. Serialized to the opaque store key; ANY difference
 * means the stored proxy is not the picture the live path would produce, so it is ignored.
 *
 * `compVersion` is the invariant that carries most of the weight — `stampFlarexComp` bumps it on every
 * graph mutation, so no node edit can slip past. `hostSignature` covers the OTHER half: the flarex hook
 * runs at the END of the layer's draw build, which means the clip's own transform/effects/trim are baked
 * INTO the comp's MediaIn and therefore into the proxy. A proxy keyed on `compVersion` alone would
 * survive a clip transform edit and show the pre-edit picture.
 */
export interface FlarexCompProxyIdentity {
  compId: string;
  compVersion: number;
  hostLayerId: string;
  hostSignature: string;
  spanDurationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

/** FNV-1a — a short, stable, non-cryptographic digest. Collisions only cost a missed re-render. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Digest of everything about the HOST CLIP that reaches the comp's MediaIn. Deliberately over-broad:
 * a false mismatch costs one wasted re-render, a false match shows stale pixels. `flarexCompId` and
 * `startSeconds` are excluded — the first is the key's own subject, and the second only moves the clip
 * on the timeline (comp-local time is `t − startSeconds`, so the rendered picture is unchanged).
 */
function hostLayerSignature(layer: TimelineLayer): string {
  const { flarexCompId: _comp, startSeconds: _start, ...rest } = layer;
  return digest(JSON.stringify(rest));
}

export function flarexCompProxyKey(identity: FlarexCompProxyIdentity): string {
  return [
    identity.compId,
    `v${identity.compVersion}`,
    identity.hostLayerId,
    identity.hostSignature,
    identity.spanDurationSeconds.toFixed(4),
    `${identity.width}x${identity.height}`,
    `@${identity.fps}`,
  ].join("|");
}

/** The identity a proxy for this (comp, host clip) pair would be rendered under right now. */
export function flarexCompProxyIdentity(
  composition: TimelineComposition,
  comp: FlarexComp,
  layer: TimelineLayer,
  fps: number
): FlarexCompProxyIdentity {
  return {
    compId: comp.id,
    compVersion: comp.version,
    hostLayerId: layer.id,
    hostSignature: hostLayerSignature(layer),
    spanDurationSeconds: layer.durationSeconds,
    width: composition.width,
    height: composition.height,
    fps,
  };
}

/**
 * The composition a proxy renders: the host clip ALONE, shifted to t=0, for exactly its own duration.
 *
 * Not `isolateFlarexHostComposition` + a work-area clip, though that is the same shape — this is built
 * directly because the proxy must capture precisely what the flarex hook returns for this one layer:
 *
 *  - other tracks are dropped (a clip stacked above is composited AFTER the hook, so baking it in would
 *    draw it twice at playback),
 *  - audio is dropped (`audio: null` anyway — a proxy is visual only),
 *  - transitions are dropped: `buildLayerDrawWithPasses` applies the flarex hook per transition SIDE and
 *    the transition mixes the two comp outputs afterwards, so a proxy that contained the transition
 *    would be mixed a second time.
 *
 * The host's own track object is preserved (minus its other layers) so any track-level property that
 * feeds the layer draw survives.
 */
function flarexProxyComposition(composition: TimelineComposition, layer: TimelineLayer): TimelineComposition | null {
  const hostTrack = composition.tracks.find((track) => track.layers.some((item) => item.id === layer.id));
  if (!hostTrack) return null;
  const { transitionIn: _in, transitionOut: _out, ...hostRest } = layer as TimelineLayer & { transitionOut?: unknown };
  const host = { ...hostRest, startSeconds: 0 } as TimelineLayer;
  return {
    ...composition,
    durationSeconds: layer.durationSeconds,
    tracks: [{ ...hostTrack, layers: [host] }],
    // In/out points are the WORK AREA (the user's export range) and have nothing to do with this span —
    // leaving them set would clip the proxy again inside `generateSpanProxy`.
    settings: composition.settings
      ? {
          ...composition.settings,
          timeline: { ...composition.settings.timeline, inPointSeconds: undefined, outPointSeconds: undefined },
        }
      : undefined,
  };
}

/**
 * Media kind + duration for every asset-source `MediaIn` in `comp`. Those assets are OFF-TIMELINE (the
 * Fusion Loader model), so nothing that walks tracks can find them — without this every loader
 * soft-degrades to the host clip in the rendered file, exactly as the local export did before
 * 2026-07-27. Unresolvable assets are omitted, which reinstates that documented soft-degrade.
 */
function flarexSourceAssetsFor(comp: FlarexComp, assets: readonly SourceAsset[]): FlarexSourceAssetMap {
  const map: FlarexSourceAssetMap = {};
  for (const assetId of collectFlarexSourceAssetIds({ [comp.id]: comp })) {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) continue;
    map[assetId] = {
      // Must be the REAL kind — an image decoded through a video provider yields nothing.
      type: asset.fileType.startsWith("image/") ? "image" : "video",
      durationSeconds: asset.durationSeconds,
    };
  }
  return map;
}

export interface RenderFlarexCompProxyInput {
  composition: TimelineComposition;
  comp: FlarexComp;
  /** The clip carrying `flarexCompId === comp.id`. Must be present in `composition`. */
  layer: TimelineLayer;
  /** Media pool, for resolving asset-source loader URLs (`fileUrl`, already locally resolved). */
  assets: readonly SourceAsset[];
  signal: AbortSignal;
  onProgress?: ((fraction: number) => void) | undefined;
}

export interface RenderedFlarexCompProxy extends StoredFlarexCompProxy {
  identity: FlarexCompProxyIdentity;
}

export class FlarexCompProxyUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlarexCompProxyUnavailable";
  }
}

/**
 * Render the comp over its host clip's span and store the result. Resolves to the stored record; throws
 * `ProxyGenerationAborted` if cancelled, `FlarexCompProxyUnavailable` if the clip isn't in the
 * composition, and a plain Error if the render itself failed (a black-frame guard trip, an undecodable
 * source). Every one of those is a fail-open outcome for the caller: no proxy, live evaluation.
 *
 * Rendered at FULL composition resolution for S1 so the output can be compared 1:1 against the live
 * path. A resolution scale is a knob for later — it changes what "pixel-identical" means and needs the
 * S2 comparison fixture in place first.
 */
export async function renderFlarexCompProxy(input: RenderFlarexCompProxyInput): Promise<RenderedFlarexCompProxy> {
  const { composition, comp, layer, assets, signal, onProgress } = input;
  const proxyComposition = flarexProxyComposition(composition, layer);
  if (!proxyComposition) {
    throw new FlarexCompProxyUnavailable("the comp's host clip is not on this composition");
  }
  const fps = Math.max(1, composition.fps || 30);
  const identity = flarexCompProxyIdentity(composition, comp, layer, fps);

  const blob = await generateSpanProxy({
    composition: proxyComposition,
    // Already clipped to the clip's own span, so the span here is the whole (shifted) composition.
    spanStartSeconds: 0,
    spanEndSeconds: layer.durationSeconds,
    fps,
    urlForAsset: (assetId) => assets.find((asset) => asset.id === assetId)?.fileUrl,
    flarexComps: { [comp.id]: comp },
    flarexSourceAssets: flarexSourceAssetsFor(comp, assets),
    signal,
    onProgress,
  });

  const stored = await putFlarexCompProxy(comp.id, flarexCompProxyKey(identity), blob);
  return { ...stored, identity };
}

export { ProxyGenerationAborted };
