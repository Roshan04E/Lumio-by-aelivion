/**
 * Flarex asset-source MediaIn — virtual media layers (FLAREX.md Phase 2, Fusion Loader model).
 *
 * A MediaIn node with a `sourceAssetId` loads a media-pool asset INTO the comp, decoded independently
 * of the timeline (so the comp is self-contained — nothing is borrowed from / removed from the
 * timeline). The compositor only knows how to decode timeline layers, so each such MediaIn is backed
 * by a synthetic, off-timeline `TimelineLayer` ("virtual loader") that every renderer runs through its
 * normal per-layer media pipeline (decode + grade → graded canvas). The renderers pass these in a
 * SEPARATE list from the real timeline layers (they never composite on their own — they only feed
 * MediaIn via the compiler's `resolveSourceDraw`).
 *
 * Time model: comp-local sync. The virtual layer mirrors the host clip's `startSeconds`/
 * `durationSeconds`, so the source plays with the comp, starting at `sourceInSeconds` (Trim In). The
 * `freeze` (Hold) knob is applied by the renderer when it computes the layer's currentTime (it has the
 * node in hand), not here — this module only assembles the decode-shaped layers.
 */

import type { TimelineComposition, TimelineLayer } from "../types";
import type { FlarexComp, FlarexNode } from "./types";

const VIRTUAL_PREFIX = "flarexsrc:";

/**
 * Narrow a composition to ONE Flarex host clip, for the node page's viewer.
 *
 * The Flarex page reuses the single shared viewer ("one viewer across pages", the Resolve model), but a
 * COMP viewer must show the comp — not the finished timeline composite. Without this, any clip stacked
 * above the host on a higher track drew over the node output, so what you saw while building the comp
 * was not the comp (user report 2026-07-26). Resolve's Fusion page shows that clip's node output alone;
 * this is that.
 *
 * Preserves duration/size/track structure so the transport, frame ruler and seek math are unchanged —
 * only the other visual layers are withheld. AUDIO layers are kept deliberately: silencing the mix when
 * you open the node page would be a surprise, and audio has no picture to pollute the viewer with.
 *
 * The host's own virtual loaders (asset-source `MediaIn`s) need no special handling — they are derived
 * from the comp registry plus the surviving host layer by {@link collectFlarexVirtualLayers}, so keeping
 * the host keeps every loader alive.
 */
export function soloLayerComposition(composition: TimelineComposition, soloLayerId: string): TimelineComposition {
  return {
    ...composition,
    tracks: composition.tracks.map((track) => ({
      ...track,
      layers: track.layers.filter((layer) => layer.type === "audio" || layer.id === soloLayerId),
    })),
  };
}

/**
 * Every media-pool asset loaded by an asset-source `MediaIn` (`sourceAssetId`), across all comps.
 *
 * THE canonical answer to "which assets does this project use that are NOT on the timeline?". A Flarex
 * comp loads its sources itself (the Fusion Loader model), so nothing that walks `composition.tracks`
 * can see them — a blind spot that has now bitten three separate subsystems in the same way:
 *   1. the preview built no virtual loaders for them (fixed 2026-07-26),
 *   2. the local export registered no decoders, so every MediaIn rendered the HOST clip (2026-07-27),
 *   3. cloud export never UPLOADED them and never remapped their local ids, so the render worker
 *      fetched an id that does not exist on the server — `unexpected status 404` (2026-07-27).
 * Anything asking "what assets does this project need?" must consult this as well as the tracks.
 */
export function collectFlarexSourceAssetIds(flarexComps: Record<string, FlarexComp> | undefined): string[] {
  if (!flarexComps) return [];
  const ids = new Set<string>();
  for (const comp of Object.values(flarexComps)) {
    for (const node of Object.values(comp.nodes)) {
      if (node.type !== "mediaIn") continue;
      const assetId = typeof node.params.sourceAssetId === "string" ? node.params.sourceAssetId : "";
      if (assetId) ids.add(assetId); // empty = the host clip, not a media-pool asset
    }
  }
  return [...ids];
}

/**
 * Rewrite every asset-source `MediaIn`'s `sourceAssetId` through `map` IN PLACE. Used by the local→server
 * asset remap on export: without it the promoted graph keeps local ids inside its comps while the timeline
 * has been remapped, and the worker 404s on them.
 */
export function remapFlarexSourceAssetIds(
  flarexComps: Record<string, FlarexComp> | undefined,
  map: Record<string, string>
): void {
  if (!flarexComps) return;
  for (const comp of Object.values(flarexComps)) {
    for (const node of Object.values(comp.nodes)) {
      if (node.type !== "mediaIn") continue;
      const assetId = typeof node.params.sourceAssetId === "string" ? node.params.sourceAssetId : "";
      const next = assetId ? map[assetId] : undefined;
      if (next) node.params.sourceAssetId = next;
    }
  }
}

/**
 * GENERATOR nodes — the node types backed by a virtual layer that the renderers RASTERIZE rather than
 * decode, mapped to the timeline layer type each becomes.
 *
 * This is the same Loader trick as an asset-source MediaIn, pointed at a different producer: the
 * renderers already know how to turn a `text`/`shape` layer into a draw (`buildLayerDraw`'s raster
 * branch, via the shared `SceneTextRasterizer`), so a generator node needs no new renderer code and no
 * new cache — it inherits the rasterizer's content-keyed caching, which is why a static Text or
 * Background rasterizes once and is then reused by version instead of re-uploading every frame.
 *
 * It also means a node's text renders IDENTICALLY to a timeline text clip, in all three renderers, by
 * construction — the same reason the compiler emits SceneDraws instead of drawing anything itself.
 */
const FLAREX_GENERATOR_LAYER_TYPES: Partial<Record<FlarexNode["type"], "text" | "shape">> = {
  text: "text",
  background: "shape",
};

/**
 * True for a virtual layer that is RASTERIZED rather than decoded (a generator node's backing layer).
 *
 * Callers that give each virtual layer a decoder/provider/media element must skip these: there is no
 * media behind them, and mounting one would spin up a media path for a layer that will never produce a
 * frame. The scene path needs no such mount — it rasterizes text/shape inside `buildSceneDraws`.
 */
export function isFlarexGeneratorVirtualLayer(layer: Pick<TimelineLayer, "type">): boolean {
  return layer.type === "text" || layer.type === "shape";
}

/**
 * The virtual layer backing one generator node.
 *
 * Deliberately NEUTRAL in transform and opacity: placement (Text x/y) and Background opacity are
 * applied by the COMPILER onto the composite quad, where they are keyframe-aware. Baking them here
 * instead would both double-apply them and freeze them, since this builder has no time to sample at.
 * Only content — glyphs, font, colour — lives on the layer, which is exactly what the raster cache
 * keys on.
 */
function buildFlarexGeneratorLayer(
  comp: FlarexComp,
  node: FlarexNode,
  host: TimelineLayer,
  kind: "text" | "shape",
): TimelineLayer {
  const params = node.params;
  const str = (key: string, fallback: string): string => (typeof params[key] === "string" ? (params[key] as string) : fallback);
  const num = (key: string, fallback: number): number => (typeof params[key] === "number" ? (params[key] as number) : fallback);
  const base = {
    id: flarexVirtualLayerId(comp.id, node.id),
    trackId: "__flarex_virtual",
    name: node.label ?? (kind === "text" ? "Text" : "Background"),
    // A generator has no media of its own, so it is active for the WHOLE comp — it never "ends" the
    // way a short asset source does.
    startSeconds: host.startSeconds,
    durationSeconds: host.durationSeconds,
    fit: "fill" as const,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
  };
  if (kind === "text") {
    const align = str("align", "center");
    return {
      ...base,
      type: "text",
      text: str("content", "Text"),
      fontFamily: str("fontFamily", "Inter"),
      fontSize: num("fontSize", 96),
      fontWeight: num("fontWeight", 700),
      color: str("color", "#ffffff"),
      textAlign: align === "left" || align === "right" ? align : "center",
    };
  }
  return {
    ...base,
    type: "shape",
    shapeKind: "rectangle",
    color: str("color", "#000000"),
    // Fills the comp — this is a Background, not a placed rectangle (that is what Rectangle + Merge is).
    widthPercent: 100,
    heightPercent: 100,
    borderRadius: 0,
  };
}

/** Stable id for the virtual loader backing one comp's MediaIn node. */
export function flarexVirtualLayerId(compId: string, nodeId: string): string {
  return `${VIRTUAL_PREFIX}${compId}:${nodeId}`;
}

export function isFlarexVirtualLayerId(id: string): boolean {
  return id.startsWith(VIRTUAL_PREFIX);
}

/** Minimal asset facts a virtual loader needs (resolved by the caller from its asset list). */
export interface FlarexSourceAssetInfo {
  type: "video" | "image";
  durationSeconds?: number | undefined;
}

/**
 * Build the virtual media layers for every asset-source MediaIn across a project's Flarex comps.
 * `layers` is the flat list of the composition's timeline layers (the HOSTS — a comp is attached to a
 * layer via `flarexCompId`); `lookupAsset` resolves an asset id to its media kind. A MediaIn whose
 * asset can't be resolved is skipped (its MediaIn soft-degrades to the host clip at compile time).
 */
export function collectFlarexVirtualLayers(
  layers: readonly TimelineLayer[],
  flarexComps: Record<string, FlarexComp> | undefined,
  lookupAsset: (assetId: string) => FlarexSourceAssetInfo | null,
): TimelineLayer[] {
  if (!flarexComps) return [];
  const out: TimelineLayer[] = [];
  for (const host of layers) {
    if (!host.flarexCompId) continue;
    const comp = flarexComps[host.flarexCompId];
    if (!comp) continue;
    for (const node of Object.values(comp.nodes)) {
      // Generator nodes (Text / Background) are backed by a RASTERIZED virtual layer — no asset to
      // resolve, so they short-circuit the media path below entirely.
      const generatorKind = FLAREX_GENERATOR_LAYER_TYPES[node.type];
      if (generatorKind) {
        out.push(buildFlarexGeneratorLayer(comp, node, host, generatorKind));
        continue;
      }
      if (node.type !== "mediaIn") continue;
      const assetId = typeof node.params.sourceAssetId === "string" ? node.params.sourceAssetId : "";
      if (!assetId) continue; // empty = the host clip, not a virtual loader
      const asset = lookupAsset(assetId);
      if (!asset) continue;
      const sourceInSeconds = typeof node.params.sourceInSeconds === "number" ? node.params.sourceInSeconds : 0;
      const freeze = node.params.freeze === true;
      // How long this loader is ACTIVE (comp-local). A video source that's shorter than the host clip
      // ENDS at its own duration — past that the MediaIn produces nothing (self-contained-clip
      // semantics), so downstream merges drop it and only the background remains (NOT a held last
      // frame). `freeze` (Hold a still), images (no timeline), and unknown-duration sources have no
      // natural end, so they mirror the host span and stay active for the whole comp.
      const sourceRemain =
        asset.type === "video" && !freeze && asset.durationSeconds != null && Number.isFinite(asset.durationSeconds)
          ? Math.max(0, asset.durationSeconds - sourceInSeconds)
          : Infinity;
      const activeSeconds = Math.min(host.durationSeconds, sourceRemain);
      out.push({
        id: flarexVirtualLayerId(comp.id, node.id),
        trackId: "__flarex_virtual",
        type: asset.type,
        name: `${node.label ?? "MediaIn"} source`,
        // Mirror the host START so comp-local time (t − hostStart) drives the source in sync with the
        // comp; the DURATION is clamped to the source's own remaining length so the loader ends when
        // its media runs out (the compiler gates on this via `resolveSourceDraw`).
        startSeconds: host.startSeconds,
        durationSeconds: activeSeconds,
        assetId,
        sourceInSeconds,
        fit: "fill",
        transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
        effects: [],
        keyframes: [],
      });
    }
  }
  return out;
}
