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

import { compositionMediaDefaults } from "../composition-style";
import { getLayerSpeed, getSpeedRamp } from "../timeline";
import type { TimelineComposition, TimelineLayer } from "../types";
import {
  applyRetimeToLoaderTiming,
  composeRetimeWithSpeedRamp,
  isIdentityFlarexTimeTransform,
  resolveFlarexMediaInRetimes,
  FLAREX_IDENTITY_TIME_TRANSFORM,
  type FlarexTimeTransform,
} from "./time-transform";
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

/**
 * The virtual loader for a HOST MediaIn that sits under a TimeSpeed — an independently decoded second
 * read of the host clip's own media, at the retimed rate.
 *
 * Why a second decode rather than asking for the host draw at another time: the host clip's decoder is
 * positioned by the timeline playhead and serves the clip itself. "The same media at a different t" is
 * a different decode, full stop — which is exactly what a loader is. This is the same Fusion Loader
 * trick an asset-source MediaIn already uses, pointed at the host's asset.
 *
 * The layer is a COPY of the host rather than the bare loader an asset-source MediaIn gets, because an
 * un-retimed host MediaIn resolves to the host's FULL draw (grade, transform, masks, passes). Building
 * a bare loader instead would strip the clip's grade the moment a TimeSpeed was added — a retime is not
 * licence to change how the shot looks. The composition fields that would make the copy re-enter the
 * pipeline or double up are stripped: `flarexCompId` (infinite recursion — this comp again), and the
 * transitions/linking/track-matte that belong to the clip's place on the timeline, not to a source read.
 *
 * Returns null (leaving the MediaIn on the un-retimed host draw) when the host is not a plain media
 * clip, or when it carries a speed ramp that this retime cannot compose with — see
 * `composeRetimeWithSpeedRamp`.
 */
function promoteHostMediaInLoader(
  comp: FlarexComp,
  node: FlarexNode,
  host: TimelineLayer,
  retime: FlarexTimeTransform,
  lookupAsset: (assetId: string) => FlarexSourceAssetInfo | null
): TimelineLayer | null {
  if (host.type !== "video" && host.type !== "image") return null;
  if (!host.assetId || host.nestedCompositionId) return null;
  const asset = lookupAsset(host.assetId);
  if (!asset) return null;
  const hostIn = host.sourceInSeconds ?? 0;
  const endless = asset.type !== "video" || asset.durationSeconds == null || !Number.isFinite(asset.durationSeconds);
  const sourceDuration = endless ? undefined : asset.durationSeconds;

  const ramped = getSpeedRamp(host) ? composeRetimeWithSpeedRamp(host, retime) : null;
  if (getSpeedRamp(host) && !ramped) return null; // reverse retime over a ramp — declined, not approximated
  const timing = applyRetimeToLoaderTiming(hostIn, getLayerSpeed(host), retime, sourceDuration);
  // A composed ramp has no single rate, so its runway can't be divided out of the source length. It
  // plays for as long as the clip does; a ramp that outruns its media was already the host's problem.
  const remaining = ramped ? Infinity : timing.remainingSeconds;

  const { flarexCompId: _comp, transitionIn: _tIn, linkedGroupId: _linked, trackMatte: _matte, ...rest } = host;
  return {
    ...rest,
    id: flarexVirtualLayerId(comp.id, node.id),
    trackId: "__flarex_virtual",
    name: `${node.label ?? "MediaIn"} host`,
    startSeconds: host.startSeconds,
    durationSeconds: Math.min(host.durationSeconds, remaining),
    sourceInSeconds: ramped ? ramped.sourceInSeconds : timing.sourceInSeconds,
    ...(ramped ? { speedKeyframes: ramped.speedKeyframes } : { speed: timing.speed, speedKeyframes: undefined }),
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
 * One virtual loader plus the derivation facts about it that a `TimelineLayer` has no channel for.
 *
 * `reachable` exists because the collection walk already knows it and used to throw it away. See
 * {@link collectFlarexVirtualLayerEntries}. It is deliberately NOT a field on `TimelineLayer`: the
 * layer type is the contract every renderer consumes, and this answer is meaningful to exactly one
 * consumer (the preview's decode-admission pressure). A field there would read as a rendering
 * instruction that two of the three renderers silently ignore.
 */
export interface FlarexVirtualLayerEntry {
  layer: TimelineLayer;
  /**
   * Whether this loader's MediaIn is reached by the backwards walk from the comp's ACTIVE ROOTS (the
   * live view dot when one is supplied, plus every MediaOut) — i.e. whether it contributes to what is
   * being viewed. False means a disconnected branch or an abandoned experiment: the compiler never
   * pulls this source, so nothing on screen changes if it stops decoding.
   *
   * Sourced from `resolveFlarexMediaInRetimes`' key set, which is exactly that reachability set (its
   * own docstring: "Nodes not reachable from any root … are absent from the map"). Every MediaIn it
   * reaches gets an entry — identity transform included — so this is a reachability answer, not a
   * "has a TimeSpeed" answer.
   *
   * CONSERVATIVE BY CONSTRUCTION, in the safe direction. The walk visits the view dot AND every
   * MediaOut, while `compileFlarexComp` evaluates the view dot and only FALLS THROUGH to MediaOut
   * (compile-flarex.ts:1824-1832). So this set is a superset of what any one compile reads: it can
   * call a node reachable that this frame did not pull, never the reverse.
   *
   * NOT an answer about `ctx.previewRootNodeId`, the per-pass re-root behind node THUMBNAILS — that
   * root is chosen after the loaders exist, and a thumbnail may legitimately read an unreachable
   * node. Thumbnails are idle-only (`ScenePreviewCanvas` hard-gates them on `!isPlaying`), which is
   * why the one consumer of this flag acts on it only while the transport is playing.
   *
   * GENERATORS ARE ALWAYS `true`. A Text+/Background loader is rasterized, never decoded, and holds
   * no session — there is nothing to reclaim, so it is never a candidate for whatever a caller does
   * with `false`. Reporting the literal map answer here would say "unreachable" about a loader that
   * costs nothing and invite a caller to act on it.
   */
  reachable: boolean;
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
  previewRoots?: Readonly<Record<string, string>> | undefined,
): TimelineLayer[] {
  return collectFlarexVirtualLayerEntries(layers, flarexComps, lookupAsset, previewRoots).map((entry) => entry.layer);
}

/**
 * {@link collectFlarexVirtualLayers}, keeping the per-loader REACHABILITY the walk already computed.
 *
 * Same layers, same order, nothing added and nothing dropped — the array is identical to what the
 * plain collector returns, because deciding a loader should not exist is the move S3.5 deliberately
 * reversed (unmounting destroys the decoder, so recovery pays a cold re-demux of N streams; see
 * `WebglMediaLayer`'s `suspended` docstring). A caller that wants an unreachable loader to cost less
 * changes what it COSTS, never whether it exists.
 */
export function collectFlarexVirtualLayerEntries(
  layers: readonly TimelineLayer[],
  flarexComps: Record<string, FlarexComp> | undefined,
  lookupAsset: (assetId: string) => FlarexSourceAssetInfo | null,
  /**
   * Live per-comp preview roots (`compId → nodeId`), ADR-012 §0.5 / slice S1.2. A node being INSPECTED
   * still needs its upstream loaders retimed, or the viewer shows the right node at the wrong moment —
   * but that root is runtime state supplied by the viewer, never the persisted `comp.previewNodeId`.
   * Omitted by export and the worker, which retime from MediaOut alone.
   */
  previewRoots?: Readonly<Record<string, string>> | undefined,
): FlarexVirtualLayerEntry[] {
  if (!flarexComps) return [];
  const out: FlarexVirtualLayerEntry[] = [];
  for (const host of layers) {
    if (!host.flarexCompId) continue;
    const comp = flarexComps[host.flarexCompId];
    if (!comp) continue;
    // TimeSpeed's media half (ADR-011): the retime each MediaIn sits under, resolved once per comp
    // from static params. Empty for every comp without a TimeSpeed, which is the shipped behaviour.
    const retimes = resolveFlarexMediaInRetimes(comp, previewRoots?.[comp.id]);
    for (const node of Object.values(comp.nodes)) {
      // Generator nodes (Text / Background) are backed by a RASTERIZED virtual layer — no asset to
      // resolve, so they short-circuit the media path below entirely.
      const generatorKind = FLAREX_GENERATOR_LAYER_TYPES[node.type];
      if (generatorKind) {
        // `reachable: true` unconditionally — a rasterized loader holds no decoder session, so it is
        // never a candidate for reclamation. See `FlarexVirtualLayerEntry.reachable`.
        out.push({ layer: buildFlarexGeneratorLayer(comp, node, host, generatorKind), reachable: true });
        continue;
      }
      if (node.type !== "mediaIn") continue;
      const assetId = typeof node.params.sourceAssetId === "string" ? node.params.sourceAssetId : "";
      // The map's KEY SET is the reachability set; the transform is what it was already read for.
      const reachable = retimes.has(node.id);
      const retime = retimes.get(node.id)?.transform ?? FLAREX_IDENTITY_TIME_TRANSFORM;
      if (!assetId) {
        // Empty id = the HOST clip. Normally no loader at all — the compiler hands that MediaIn the
        // host's own finished draw. Under a retime it needs one, because the host's picture comes from
        // the timeline's decoder, which sits at the playhead and cannot also be somewhere else. See
        // `promoteHostMediaInLoader`.
        // Always reachable when it exists at all: a non-identity retime can only come FROM the map,
        // so an unreachable host MediaIn reads identity and is promoted to nothing.
        const promoted = isIdentityFlarexTimeTransform(retime)
          ? null
          : promoteHostMediaInLoader(comp, node, host, retime, lookupAsset);
        if (promoted) out.push({ layer: promoted, reachable: true });
        continue;
      }
      const asset = lookupAsset(assetId);
      if (!asset) continue;
      const declaredIn = typeof node.params.sourceInSeconds === "number" ? node.params.sourceInSeconds : 0;
      const freeze = node.params.freeze === true;
      // How long this loader is ACTIVE (comp-local). A video source that's shorter than the host clip
      // ENDS at its own duration — past that the MediaIn produces nothing (self-contained-clip
      // semantics), so downstream merges drop it and only the background remains (NOT a held last
      // frame). `freeze` (Hold a still), images (no timeline), and unknown-duration sources have no
      // natural end, so they mirror the host span and stay active for the whole comp.
      //
      // A retime rewrites BOTH the rate and this runway: a 0.5× source lasts twice as long in comp
      // seconds, and leaving the runway un-retimed would end the loader — blanking the MediaIn — with
      // half the footage unplayed.
      const endless = asset.type !== "video" || freeze || asset.durationSeconds == null || !Number.isFinite(asset.durationSeconds);
      const timing = applyRetimeToLoaderTiming(declaredIn, 1, retime, endless ? undefined : asset.durationSeconds);
      const activeSeconds = Math.min(host.durationSeconds, timing.remainingSeconds);
      const layer: TimelineLayer = {
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
        sourceInSeconds: timing.sourceInSeconds,
        ...(timing.speed === 1 ? {} : { speed: timing.speed }),
        // Was hardcoded "fill" (stretches a mismatched-aspect source to the comp frame) with no
        // rationale attached — unlike `transform` two fields below, which carries one. A picture must
        // not change depending on which surface drew it: this is the SAME default a normal timeline
        // video layer gets (compositionMediaDefaults.fit, via getCompositionObjectFit — the one
        // fit-resolution path every renderer shares), so a MediaIn source now agrees with the timeline
        // instead of silently overriding it.
        fit: compositionMediaDefaults.fit,
        /**
         * INHERITED from the host, not manufactured (ADR-020 slice B; F2 in the Phase 0 record).
         *
         * This was a hardcoded `{ scale: 1, opacity: 100 }`. Nobody supplied it — the collection path
         * invented it — and because `getLayerVisibleContribution` derives ranking merit from exactly
         * these two numbers, **every Flarex virtual source scored a merit of exactly 1.0, always.**
         * Measured: two hosts at `scale 1 / opacity 100` and `scale 0.1 / opacity 10` produced virtual
         * layers that were byte-identical, and rank could not discriminate between any two virtual
         * sources in the runtime (`contribution:scope`, 9/9).
         *
         * That is DEBT-012's shape — *proof by a signal the subject never emits*. An UNDECLARED
         * contribution ranks at `UNDECLARED_RANK` and honestly says "we do not know"; a manufactured
         * identity transform asserts "full area, full opacity, fully contributing" with authority, and
         * it made the instrument that was supposed to detect the gap (`U`, the undeclared fraction)
         * read a clean 0.0%.
         *
         * The comp draws into the host clip's rectangle, so the host's transform is the honest bound on
         * what any node inside it can contribute to the frame — a source inside a half-scale, 10%-opacity
         * host cannot contribute a full frame, and must not outrank one that does.
         *
         * NOT DRAWN: virtual layers mount with `hideVisual` and feed the scene compositor through a
         * graded canvas; the picture comes from the comp graph's own transforms. This transform is read
         * for contribution, which is why changing it is a decoder-topology change (it changes who wins a
         * session) and not a rendering change. The pixel gate is the evidence for that claim, not this
         * comment.
         *
         * WHAT THIS DOES NOT DO, stated so the next reader does not assume it: siblings inside ONE comp
         * on ONE host still score identically, because they inherit the same host. Discriminating
         * between them needs each node's own contribution within the comp — reachability from the active
         * root, and composited area — which has no channel on a `TimelineLayer` today. See ADR-020 §5.
         */
        transform: host.transform ?? { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
        effects: [],
        keyframes: [],
      };
      out.push({ layer, reachable });
    }
  }
  return out;
}
