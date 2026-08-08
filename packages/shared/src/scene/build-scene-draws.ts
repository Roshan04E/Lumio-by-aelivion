/**
 * Shared SceneCompositor draw-list builder (Method 3, Phase 5).
 *
 * Builds the `SceneLayerDraw[]` for a frame from `(layers, time)` — object-fit + clip mask + transform +
 * blend + blur/glow + 3D tilt + junction transitions — using only framework-agnostic pieces. The EDITOR
 * (`ScenePreviewCanvas`) and the LOCAL EXPORT (`SceneFrameCompositor`) both call this so the on-screen
 * preview and the exported MP4 composite through the exact same logic (the whole point of Method 3).
 *
 * The ONLY environment-specific input is `getMediaGraded`: the editor reads each media layer's graded
 * canvas from the hidden `WebglMediaLayer`s (`gradedRef`); the export grades the WebCodecs-decoded frame
 * inline through a per-layer `MediaWebGLRenderer`. Everything else — the text raster, mask matte, overlay
 * grade, and transition mix — is built here from shared instances the caller owns + pools across frames.
 */

import { getTexImageSourceProducerInfo } from "../color/gl-context";
import { frameProfiler } from "../color/frame-profiler";
import { MediaWebGLRenderer } from "../color/media-renderer";
import { colorPipelineCacheKey } from "../color/pipeline";
import type { ColorPipeline, GradeCompare } from "../color/types";
import { getFragmentEffect } from "../color/fragment-effects/registry";
import { builtinFragmentEffectId } from "../color/fragment-effects/builtins";
import { isSceneTextureSource } from "../color/scene-compositor";
import type { SceneDraw, SceneFragmentPass, SceneGroupDraw, SceneLayerDraw, SceneRegionPass, SceneTextureSource } from "../color/scene-compositor";
import type { ServedTime } from "../kernel/time";
import {
  getActiveTransition,
  getCompositionBlendMode,
  getCompositionColorPipeline,
  getCompositionContentTransform,
  getCompositionFilterEffects,
  getCompositionObjectFit,
  getCompositionTransform,
  type ActiveTransition,
} from "../composition-style";
import { evaluateTimelineEffectParam } from "../animation";
import { FRAGMENT_PASS_EFFECT_TYPES, expandLayerEffectRegions, hasRegionColorEffect } from "../clip-masks";
import { NEST_ID_SEPARATOR, type NestedGroupSpec } from "../nesting";
import { fragmentEffectParamsFromStorage, SHADER_MANIFEST_ID_PARAM_KEY } from "../plugin-effect-adapter";
import { compileFlarexComp, type FlarexValue } from "../flarex/compile-flarex";
import { flarexVirtualLayerId } from "../flarex/virtual-layers";
import { FlarexSourceDrawCache } from "../flarex/source-draw-cache";
import type { FlarexComp } from "../flarex/types";
import type { FlarexDegradation } from "../flarex/degradation";
import type { TimelineEffectParamValue, TimelineLayer, TransitionSpec } from "../types";
// VALUE import (not type-only): nested-comp masks need their OWN matte-cache instance, sized to the
// nested composition, distinct from the parent's — lazily constructed here and pooled in the caller-
// owned `nestMatteCaches` map (mirrors how `builtinGradeOverlay` below lazily constructs
// `MediaWebGLRenderer`s into the caller-owned `gradeRenderers` map).
import { SceneMaskMatteCache } from "./scene-mask-matte";
import type { SceneTextRasterizer } from "./scene-text-raster";

/** A `<canvas>` (main thread) or `OffscreenCanvas` (export Worker) — the pooled grade/transition surfaces. */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * The SHIPPED default of the region-effect pass model — the single flip point every consumer derives
 * from: the web flag helper (`getRegionPassesEnabled` env fallback), the render-manifest builder
 * (`RenderManifest.regionPassModel`, so the cloud renderer flips in lockstep), and gates. Never flip one
 * renderer alone; per-session escape hatch stays `?regionPasses=0`.
 *
 * FLIPPED ON 2026-07-02 after the full gate ladder in real Chrome: `scene:compare` 22/22 in both flag
 * states (incl. the `overlap-region-effects` 3-way fixture: clone-parity 0.249%, combine-delta 24.77%
 * ≥ 2% floor at strict threshold) and `render:compare:pixels` on all region fixtures + transition.
 */
export const REGION_PASS_MODEL_DEFAULT = true;

/** An active junction transition at the current time — the scene pass mixes the two clips' graded canvases
 *  (Phase 4.2) instead of the DOM `TransitionOverlay`. */
export interface ScenePreviewTransition {
  outgoingId: string;
  incomingId: string;
  spec: TransitionSpec;
  startSeconds: number;
  /** R3.1 handle-aware window: seconds of the window BEFORE the cut (`resolveTransitionWindowSides`). Absent → centered. */
  prerollSeconds?: number | undefined;
  fromFit: "cover" | "contain" | "fill";
  toFit: "cover" | "contain" | "fill";
}

/**
 * One pre-rendered frame of a Flarex comp (plans/flarex-comp-proxy.md, S2) — the whole comp output,
 * full-frame, at the current time. `sourceVersion` lets the compositor skip a redundant texture upload
 * when the decoder has not advanced.
 */
export interface FlarexCompProxyFrame {
  source: TexImageSource | SceneTextureSource;
  sourceWidth: number;
  sourceHeight: number;
  sourceVersion?: number | undefined;
  /**
   * The moment this pre-rendered frame represents (ADR-012 T7, slice S4.2).
   *
   * T7 is one sentence — "a proxy is a source; it carries a time, participates in readiness, and is
   * subject to every rule above" — and this field is the half of it that was missing. A proxy frame
   * had a version and no time, so the one participant standing in for a whole comp was the one
   * participant a coherence check could not evaluate. It could be arbitrarily behind the playhead and
   * read as ready, because there was nothing to read.
   *
   * Optional on the same terms as `SceneTextureSource.servedTime`: absent means the path cannot say,
   * never that the frame is current.
   */
  servedTime?: ServedTime | undefined;
}

export interface BuildSceneDrawsInputs {
  /** ALL scene-eligible visual layers (media + text/shape) in back-to-front (z) order, incl. transition pairs. */
  layers: TimelineLayer[];
  /** Logical comp size (drives text layout + the matte). */
  width: number;
  height: number;
  currentTime: number;
  /** Playback render-resolution scale (1 = Full); only the element-box quad half-extents scale with it. */
  renderScale: number;
  transitions: ScenePreviewTransition[];
  rasterizer: SceneTextRasterizer | null;
  matteCache: SceneMaskMatteCache | null;
  /** Per-text/shape-layer overlay-grade renderer pool (owned by the caller; pruned here). Used only by the
   *  built-in own-canvas overlay grade — ignored when `gradeOverlay` below is injected. */
  gradeRenderers: Map<string, { renderer: MediaWebGLRenderer; pipelineKey: string }>;
  /** Each media layer's graded source — a canvas (own-canvas path) OR a same-context texture (single-context
   *  export, Phase 2), or null if not ready. */
  getMediaGraded: (layerId: string) => AnyCanvas | SceneTextureSource | null;
  /**
   * Optional injected text/shape overlay-grade (Phase 2 single-context export): grade the ungraded raster into a
   * same-context `RenderTarget` and return it as a `SceneTextureSource`. When omitted (editor preview + legacy
   * export) the built-in own-canvas grade runs unchanged. Either way the GRADE MATH is identical — only the
   * output surface (own canvas vs shared RTT) differs.
   */
  gradeOverlay?: (layerId: string, srcCanvas: AnyCanvas, pipeline: ColorPipeline) => TexImageSource | SceneTextureSource | null;
  /** Canvas factory for the pooled grade/transition renderers (DOM `<canvas>` or `OffscreenCanvas`). */
  createCanvas: () => AnyCanvas;
  /**
   * Region-effect PASS model (flag-gated; see todo.md "Region-effect model" TRUE fix): fold each layer's
   * `__rfx_` region-expansion clones into ordered `regionPasses` on the BASE draw instead of emitting them as
   * stacked clone draws. The upstream expansion (`expandEffectRegionMasks`) and per-clone grading are
   * unchanged — only the composite differs: region blur applies to the layer's RUNNING image (combines with
   * the base grade / earlier passes), region color composites its clone-graded image masked, inside a
   * per-layer nest. Default false = today's clone-stack composite, byte-identical.
   */
  regionPassModel?: boolean | undefined;
  /**
   * Compound-clip group specs from `expandNestedCompositions` (NESTING.md Phase C). `layers` (above) is
   * the FULLY EXPANDED layer list (nested children already present as ordinary layers with `__nest_`-
   * namespaced ids) — this map is ONLY consulted to fold those children back into a `SceneGroupDraw` per
   * compound-clip instance + build its `shell`. Undefined/empty = no nesting, and every code path below
   * that reads it degrades to a no-op — non-nested compositions build byte-identical to before this field
   * existed.
   */
  nestedGroups?: ReadonlyMap<string, NestedGroupSpec> | undefined;
  /**
   * Per-NESTED-COMPOSITION matte-cache pool, keyed by nested composition id (NOT by clip instance —
   * multiple instances of the same nest share one cache sized to that composition; their masks stay
   * separate because layer ids are already per-instance-namespaced). Caller-owned (dispose on unmount),
   * lazily populated by this function exactly like `gradeRenderers`. Omit when the comp has no nesting;
   * if `nestedGroups` IS non-empty but this is omitted, nested children simply render WITHOUT their clip
   * masks (soft degrade, not a crash) — see the `// NEST-REVIEW:` note near its use.
   */
  nestMatteCaches?: Map<string, SceneMaskMatteCache> | undefined;
  /**
   * R1 fix: called with a layer's id whenever `buildLayerDraw` returns null because its source isn't
   * ready yet (text raster not landed, media graded canvas not landed) — the ONLY two `return null`
   * sites below. The worker renderer already gates the frame on this exact condition
   * (`SceneStage.tsx`'s `delayRender`/`composite()` contract); the web preview has no equivalent, so
   * without this hook a stacked-layer frame briefly shows the layer BELOW an unready top layer. Omit
   * (export/worker callers) for byte-identical behavior — this is purely an observability out-channel,
   * it never changes what `buildSceneDraws` returns.
   */
  onLayerNotReady?: (layerId: string) => void;
  /**
   * Flarex node-comp registry (FLAREX.md): when a layer carries `flarexCompId` and its comp is here,
   * the layer's finished draw becomes the comp's MediaIn and the LOWERED graph replaces it at the
   * clip's z-slot (`compileFlarexComp` — pure SceneDraw construction, so all three renderers get the
   * comp output through this one hook). Undefined/missing comp = the clip renders plain, byte-identical
   * to before this field existed.
   */
  flarexComps?: Record<string, FlarexComp> | undefined;
  /**
   * Pre-rendered comp frames, by comp id (plans/flarex-comp-proxy.md, S2). When a `flarexCompId` layer
   * has an entry, the lowered graph is REPLACED by this image and `compileFlarexComp` never runs — the
   * playback win. The caller owns validity: it must only pass a frame whose stored key still matches the
   * comp's current identity, and only where an OPAQUE stand-in is safe (`canSubstituteFlarexProxy` —
   * rendered proxies bake the composition background, so a comp with anything drawn below it must keep
   * evaluating live).
   *
   * PLAYBACK ONLY. Export must always re-render from the graph — the render manifest is the product
   * contract and a cached frame is a lossy derivative — so `export-core` never sets this, and the
   * Remotion path never sets it either. Absent ⇒ byte-identical to before this field existed, which is
   * what keeps an export with a proxy on disk identical to one without.
   */
  flarexCompProxies?: Record<string, FlarexCompProxyFrame> | undefined;
  /**
   * Asset-source MediaIn virtual loaders (FLAREX.md Phase 2, Fusion model): synthetic off-timeline
   * media layers — one per MediaIn node that loads a media-pool asset — built by
   * `collectFlarexVirtualLayers`. The caller must ALSO have decoded/graded them (so `getMediaGraded`
   * returns each one's canvas by its virtual id); here they are consulted ONLY by the Flarex
   * compiler's `resolveSourceDraw` to build a source draw, never composited independently. Omitted/
   * empty = every MediaIn resolves to its host clip (no asset sources), byte-identical to before.
   */
  flarexVirtualLayers?: TimelineLayer[] | undefined;
  /**
   * Runtime-only Flarex materialization policy (Flarex evaluation engine, Slice 1): node ids whose
   * output the compiler must seal into its own render-target boundary. Forwarded verbatim to
   * `compileFlarexComp`'s `materializeNodeIds`. NEVER serialized — it is not carried on the graph or
   * the render manifest; absent in production → byte-identical to before this field existed. Used
   * only by the parity gate that renders a materialized variant of a comp.
   */
  flarexMaterializeNodeIds?: ReadonlySet<string> | undefined;
  /**
   * Runtime re-root for a Flarex compile (Slice 4, node previews): compile the comp as if this node were
   * the output. Forwarded verbatim to `compileFlarexComp`'s `previewRootNodeId`, which takes precedence
   * over the comp's persisted `previewNodeId` WITHOUT mutating it — so rendering a node thumbnail can
   * never move the user's own view-dot selection. NEVER serialized (not on the graph or the render
   * manifest); absent in production → byte-identical to before this field existed. A thumbnail pass
   * renders one comp at a time, so a single id is sufficient.
   */
  flarexPreviewRootNodeId?: string | undefined;
  /**
   * EDITOR GRADE COMPARE for Flarex comps (viewer-only). Forwarded verbatim to `compileFlarexComp`'s
   * `gradeCompare`, which makes every colour node in the comp apply to one side of the split. Absent
   * in export/Remotion → byte-identical to before this field existed.
   *
   * Separate from the media path's compare (which travels on the layer, in the source's UV space)
   * because a comp's grade is in its nodes: the split here is a plain comp-width fraction.
   */
  flarexGradeCompare?: GradeCompare | null | undefined;
  /**
   * PER-COMP preview roots (`compId → nodeId`) — the live viewer's view dots (ADR-012 §0.5, S1.2).
   *
   * Separate from the scalar {@link flarexPreviewRootNodeId} above, and it has to be: that one is the
   * thumbnail path, which renders ONE comp in isolation, so a single id is sufficient there. A live
   * frame can contain several comps, each with its own dot — passing a scalar would re-root every comp
   * in the frame to one node, which is a worse bug than the one this slice fixes.
   *
   * Runtime-only, exactly like the scalar: never serialized, never on the render manifest. Export and
   * the worker pass nothing, so they always begin at each comp's MediaOut — which is the whole point
   * of I-26. The scalar wins when both are present (a thumbnail pass is explicitly re-rooting).
   */
  flarexPreviewRoots?: Readonly<Record<string, string>> | undefined;
  /**
   * Flarex lowering degradation out-channel (slice S0.2) — forwarded verbatim to `compileFlarexComp`'s
   * `onDegrade`, with the comp id attached so a caller with several comps in one frame can attribute a
   * node without a second lookup.
   *
   * Same contract as {@link onLayerNotReady} beside it: **purely observability**, it never changes what
   * `buildSceneDraws` returns, and omitting it (export, worker, fixtures) is byte-identical. See
   * `flarex/degradation.ts` for why the three host-substitution reasons are reported separately.
   */
  onFlarexDegrade?: ((compId: string, degradation: FlarexDegradation) => void) | undefined;
  /**
   * Incremental evaluation channels (slices S6.4/S6.6), forwarded verbatim to `compileFlarexComp`.
   *
   * Both are pass-through: this module holds no records, consults no planner and owns no policy — it
   * only knows which comp is being lowered, which is exactly the piece the host cannot supply on its
   * own. `onEvaluated` reports what a node produced; `reuseValue` answers whether a node's previous
   * result may be served instead of lowering it. Absent (export, worker, fixtures, flag off) ⇒ every
   * node is lowered, byte-identical to before the slices.
   *
   * Comp-scoped by construction: the ids handed over are node ids, so a host with several comps in one
   * frame MUST namespace by comp or two comps' node `n0` would share a record. The comp id is attached
   * here rather than trusted to the host for the same reason `onFlarexDegrade` attaches it.
   */
  flarexOnEvaluated?: ((compId: string, nodeId: string, contextKey: string, value: unknown) => void) | undefined;
  flarexReuseValue?: ((compId: string, nodeId: string, contextKey: string) => FlarexValue | null) | undefined;
  /**
   * Cross-frame cache for Flarex asset-source draws (perf: `resolveSourceDraw` rebuilt a full per-clip
   * draw every frame, ~54% of compile time — profiler-measured). A BARE virtual loader's draw structure
   * is time-invariant, so on a hit the cached immutable template is reused and only the live media handle
   * (`source`/`sourceVersion`/size) is rebound. Owned + persisted across frames by the caller (like
   * `matteCache`); omitted (export/Remotion/tests) = every source draw is rebuilt fresh, byte-identical to
   * before this field existed. Output is byte-identical either way (parity gate).
   */
  flarexSourceDrawCache?: FlarexSourceDrawCache | undefined;
}

/** Effect types that route through the builtin fragment-shader harness (`buildFragmentPasses` below).
 *  Canonical list lives in clip-masks.ts (`FRAGMENT_PASS_EFFECT_TYPES`) so the adjustment-mask stamping
 *  and region expansion stay in lockstep with what actually mattes per-effect here. */
const BUILTIN_FRAGMENT_EFFECT_TYPES = FRAGMENT_PASS_EFFECT_TYPES;

/** Parse `#rgb`/`#rrggbb`/`rgb()`/`rgba()` into straight-alpha rgb 0..1 (alpha ignored — glow tint). */
function parseCssColor(input: string): [number, number, number] {
  const s = (input || "").trim();
  const hex = s.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [parseInt(hex[0]! + hex[0]!, 16) / 255, parseInt(hex[1]! + hex[1]!, 16) / 255, parseInt(hex[2]! + hex[2]!, 16) / 255];
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m && m[1]) {
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    return [(parts[0] ?? 0) / 255, (parts[1] ?? 0) / 255, (parts[2] ?? 0) / 255];
  }
  return [0, 0, 0];
}

/**
 * Build the frame's `SceneLayerDraw[]`. Mutates the passed grade/transition pools (lazy create + prune of
 * renderers for layers/junctions no longer present) so live WebGL contexts stay bounded. Pure w.r.t. its
 * inputs otherwise — the same `(layers, t)` produces the same list.
 */
export function buildSceneDraws(inputs: BuildSceneDrawsInputs): SceneDraw[] {
  const {
    layers: inputLayers,
    width: w,
    height: h,
    currentTime: t,
    renderScale: rScale,
    transitions: tPairs,
    rasterizer,
    matteCache,
    gradeRenderers,
    getMediaGraded,
    gradeOverlay: injectedGradeOverlay,
    createCanvas,
    regionPassModel = false,
    nestedGroups,
    nestMatteCaches,
    onLayerNotReady,
  } = inputs;

  // DISABLED clips draw nowhere — the single choke point shared by the editor preview, local export
  // and worker renderer (render parity by construction). Region-expansion clones and nested children
  // carry their base/shell clip's id as a prefix, so they drop with it even if the expansion didn't
  // copy the flag.
  const disabledIds = new Set(inputLayers.filter((layer) => layer.disabled).map((layer) => layer.id));
  const isFromDisabledClip = (layer: TimelineLayer): boolean => {
    if (layer.disabled) return true;
    if (disabledIds.size === 0) return false;
    const rfx = layer.id.indexOf("__rfx_");
    if (rfx > 0 && disabledIds.has(layer.id.slice(0, rfx))) return true;
    const nest = layer.id.indexOf(NEST_ID_SEPARATOR);
    if (nest > 0 && disabledIds.has(layer.id.slice(0, nest))) return true;
    return false;
  };
  const ls = inputLayers.filter((layer) => !isFromDisabledClip(layer));

  // Layer lookup so a transition can build each side as a FULL layer draw (effects included).
  const layerById = new Map(ls.map((layer) => [layer.id, layer]));

  // ─── Nesting: group ownership (moved ahead of the transition fold loop below — R2 fix) ──────────────
  // `ls` is the FULLY EXPANDED layer list (nested children already ordinary layers with `__nest_`-
  // namespaced ids, per `expandNestedCompositions`); `nestedGroups` carries each compound-clip instance's
  // shell + nested-comp geometry, keyed by that SAME namespacing. Every block below is a no-op when
  // `nestedGroups` is undefined/empty — non-nested compositions never touch this code (byte-identical).
  const groupKeys = nestedGroups ? [...nestedGroups.keys()] : [];
  // Longest-prefix-match: an id's DIRECT (innermost) owning group is the LONGEST key K such that
  // `id.startsWith(K + NEST_ID_SEPARATOR)` — e.g. for keys ["a", "a__nest_b"], id "a__nest_b__nest_c"
  // matches both, but "a__nest_b" is more specific → correct owner. Sorting once by length descending and
  // taking the FIRST match gives the longest by construction.
  const groupKeysByLengthDesc = [...groupKeys].sort((a, b) => b.length - a.length);
  const resolveOwnerGroupKey = (id: string): string | null => {
    for (const key of groupKeysByLengthDesc) {
      if (id.startsWith(key + NEST_ID_SEPARATOR)) return key;
    }
    return null;
  };
  // DIRECT (innermost) owner of every LEAF layer id, and of every GROUP key itself (a group key
  // containing `__nest_` is an INNER group — the SAME resolution applied to the key string).
  const layerOwnerGroup = new Map<string, string>();
  const groupOwnerGroup = new Map<string, string | null>();
  if (groupKeys.length > 0) {
    for (const layer of ls) {
      const owner = resolveOwnerGroupKey(layer.id);
      if (owner) layerOwnerGroup.set(layer.id, owner);
    }
    for (const key of groupKeys) groupOwnerGroup.set(key, resolveOwnerGroupKey(key));
  }

  // Junction transitions fold TWO clip GROUPS into one mix draw. A "clip" is not one layer: a region-mask
  // effect expands it into a base + render-only `${baseId}__rfx_${effectId}` layers (region blur today, region
  // colour, or any future plugin region effect). A transition side must therefore composite the clip's WHOLE
  // group — base + every `__rfx_` layer — not a single layer, or those effect layers vanish DURING the
  // transition (or leak over the other clip). This is generic over effect type: nothing here knows what the
  // region effect IS, only that `__rfx_` layers belong to their base clip. The editor + export share this, so
  // the on-screen preview and the generated proxy stay aligned by construction.
  const transitionOutgoingIds = new Set(tPairs.map((pair) => pair.outgoingId));
  const transitionByIncomingId = new Map(tPairs.map((pair) => [pair.incomingId, pair]));
  const regionCloneBaseId = (layerId: string): string | null => {
    const marker = layerId.indexOf("__rfx_");
    return marker > 0 ? layerId.slice(0, marker) : null;
  };
  // Transitions ACTIVE at `t`, keyed by incoming id, plus every layer folded into one: the outgoing clip's
  // whole group and the incoming clip's `__rfx_` layers (the incoming BASE stays — it emits the mix at its
  // z-slot). A layer in `foldedIds` is drawn inside a side group, never independently.
  const activeByIncomingId = new Map<string, ActiveTransition>();
  const foldedIds = new Set<string>();
  // R2 step 3 (D4): active transitions whose BOTH sides live in the SAME nest, keyed by the owning
  // group. `buildGroupDraw` emits these as an in-group mix draw at the incoming child's z-slot (the
  // compositor's child loop already renders transition draws inside a nest). Cross-nest and
  // half-nested pairs still degrade to a hard cut (the outgoing side simply drops, per R2).
  const groupPairsByOwner = new Map<string, { incomingId: string; outgoingId: string; active: ActiveTransition }[]>();
  // Block 4c: a junction side may be a COMPOUND clip — absent from the expanded `ls`, but present as a
  // group key (`findTransitionPairsWithGroupJunctions` keys such pairs off the RAW comp's junctions).
  // The side then pre-composes as the finished group (shell included) instead of a clip group.
  const isGroupSide = (id: string): boolean => Boolean(nestedGroups?.has(id)) && !layerById.has(id);
  for (const pair of tPairs) {
    const active = getActiveTransition(pair.spec, {
      currentTimeSeconds: t,
      startSeconds: pair.startSeconds,
      clipDurationSeconds: layerById.get(pair.incomingId)?.durationSeconds ?? nestedGroups?.get(pair.incomingId)?.clip.durationSeconds,
      prerollSeconds: pair.prerollSeconds,
    });
    if (
      !active ||
      !(layerById.has(pair.outgoingId) || isGroupSide(pair.outgoingId)) ||
      !(layerById.has(pair.incomingId) || isGroupSide(pair.incomingId))
    ) {
      continue;
    }
    // R2 fix: a nested clip must never enter the TOP-LEVEL fold — `membersByGroup` (built below) excludes
    // any id in `foldedIds`/`transitionOutgoingIds`, so a group-owned side used to vanish from its group
    // entirely once folded here (it has no top-level draw either, since nothing at this level owns it).
    if (layerOwnerGroup.has(pair.outgoingId) || layerOwnerGroup.has(pair.incomingId)) {
      const owner = layerOwnerGroup.get(pair.incomingId);
      if (owner && owner === layerOwnerGroup.get(pair.outgoingId)) {
        const list = groupPairsByOwner.get(owner);
        const entry = { incomingId: pair.incomingId, outgoingId: pair.outgoingId, active };
        if (list) list.push(entry);
        else groupPairsByOwner.set(owner, [entry]);
      }
      continue;
    }
    activeByIncomingId.set(pair.incomingId, active);
    for (const layer of ls) {
      const base = regionCloneBaseId(layer.id);
      if (layer.id === pair.outgoingId || base === pair.outgoingId || base === pair.incomingId) {
        foldedIds.add(layer.id);
      }
    }
  }
  // ─── Track matte (D1): resolve each consumer's SOURCE clip ──────────────────────────────────────
  // The source is the NEAREST slot above the consumer in z order (next non-clone entry in `ls`, which
  // is back-to-front), within the SAME scope: a top-level consumer sees top-level layers — and a whole
  // compound-clip group as ONE slot; a nested consumer sees siblings inside its own nest. A consumed
  // source never draws independently (suppressed below, like `foldedIds`) — UNLESS it's part of an
  // active transition fold, where suppressing it would eat the mix; then it stays visible and the
  // matte just reads its standalone image. A consumer with `trackMatte` but NO source at `t` renders
  // with an EMPTY matte (`draw: null` → invisible, or fully visible when inverted), so a matte clip
  // ending doesn't flash the consumer back to full.
  type MatteSourceRef = { kind: "layer"; layer: TimelineLayer } | { kind: "group"; key: string };
  const matteSourceIds = new Set<string>();
  const matteSourceGroupKeys = new Set<string>();
  const matteSourceByConsumer = new Map<string, MatteSourceRef | null>();
  for (let i = 0; i < ls.length; i++) {
    const consumer = ls[i]!;
    if (!consumer.trackMatte) continue;
    if (regionCloneBaseId(consumer.id)) continue; // region clones follow their base clip
    const owner = layerOwnerGroup.get(consumer.id) ?? null;
    let resolved: MatteSourceRef | null = null;
    for (let j = i + 1; j < ls.length; j++) {
      const candidate = ls[j]!;
      if (regionCloneBaseId(candidate.id)) continue; // a clone is part of the slot below it, not a slot
      const candidateOwner = layerOwnerGroup.get(candidate.id) ?? null;
      if (candidateOwner === owner) {
        resolved = { kind: "layer", layer: candidate };
      } else if (owner === null && candidateOwner !== null) {
        // The slot above a top-level consumer is a compound clip: its TOP-LEVEL group is the matte.
        let key = candidateOwner;
        for (let up = groupOwnerGroup.get(key); up; up = groupOwnerGroup.get(key) ?? null) key = up;
        resolved = { kind: "group", key };
      }
      // First non-clone candidate decides: same-scope hit, group hit, or out of scope (no matte —
      // a nested consumer's "above" left its nest, so there is nothing above it IN scope).
      break;
    }
    matteSourceByConsumer.set(consumer.id, resolved);
    if (!resolved) continue;
    if (resolved.kind === "group") {
      matteSourceGroupKeys.add(resolved.key);
    } else if (
      !transitionOutgoingIds.has(resolved.layer.id) &&
      !foldedIds.has(resolved.layer.id) &&
      !activeByIncomingId.has(resolved.layer.id)
    ) {
      matteSourceIds.add(resolved.layer.id);
    }
  }

  // Asset-source MediaIn virtual loaders (FLAREX.md Phase 2): keyed by virtual layer id, consulted
  // only by `resolveSourceDraw` below to build a MediaIn's source draw. These NEVER enter the main
  // composite loop — a comp is self-contained, so nothing is borrowed from / suppressed on the timeline.
  const flarexVirtualById = new Map((inputs.flarexVirtualLayers ?? []).map((layer) => [layer.id, layer] as const));

  // A clip's group as ordered (back-to-front) layer draws: base + its region-expansion layers, dropping any
  // whose source/raster isn't ready. The compositor renders these into the side RTT in order, then mixes.
  // Pass model: the clones ARE the base draw's `regionPasses`, so the group collapses to the single base draw.
  const buildClipGroup = (baseId: string): (SceneLayerDraw | SceneGroupDraw)[] => {
    const group: (SceneLayerDraw | SceneGroupDraw)[] = [];
    for (const layer of ls) {
      if (regionPassModel ? layer.id === baseId : layer.id === baseId || regionCloneBaseId(layer.id) === baseId) {
        const draw = buildLayerDrawWithPasses(layer);
        if (draw) group.push(draw);
      }
    }
    return group;
  };
  const draws: SceneDraw[] = [];

  // Grade a text/shape raster through the per-layer MediaWebGLRenderer (the same LUT engine media +
  // the export overlay path use). Returns the graded canvas, or null if a GL context can't be made
  // (then the caller composites the ungraded raster — a soft degrade, never a hard fail).
  const builtinGradeOverlay = (layerId: string, srcCanvas: AnyCanvas, pipeline: ColorPipeline): TexImageSource | null => {
    let entry = gradeRenderers.get(layerId);
    if (!entry) {
      try {
        entry = { renderer: new MediaWebGLRenderer(createCanvas()), pipelineKey: "" };
      } catch {
        return null;
      }
      gradeRenderers.set(layerId, entry);
    }
    const key = colorPipelineCacheKey(pipeline);
    if (entry.pipelineKey !== key) {
      entry.renderer.setPipeline(pipeline);
      entry.pipelineKey = key;
    }
    entry.renderer.draw({
      source: srcCanvas as TexImageSource,
      sourceWidth: srcCanvas.width,
      sourceHeight: srcCanvas.height,
      matte: null,
      pipeline,
      amount: 1,
      opacity: 1,
      mediaEffects: null,
    });
    return entry.renderer.canvas;
  };
  // Single-context export injects its own RTT-based overlay grade; otherwise use the built-in own-canvas one.
  const gradeOverlay = injectedGradeOverlay ?? builtinGradeOverlay;

  /**
   * The media-layer PRESENTATION fields (fit/blend/transform/3D tilt/mask/blur/glow/content) for `layer`
   * — everything a `SceneLayerDraw` needs EXCEPT an actual source. Shared by the ordinary media-layer
   * draw (which adds source/sourceWidth/sourceHeight/sourceVersion below) and a compound clip's `shell`
   * (NESTING.md Phase C — the finished nest RTT stands in for the source, but a compound clip's own
   * fit/mask/blur/glow/blend/transform are evaluated exactly like any other media layer). Always in
   * PARENT time/coordinates: a compound clip is a normal parent-level layer for these purposes regardless
   * of what's inside it, so `t`/`rScale` are the outer closure's — only the matte-cache instance varies
   * (`mc`, defaulting to the parent `matteCache`; nested children pass their nest-specific instance).
   */
  const buildShellPresentation = (
    layer: TimelineLayer,
    mc: SceneMaskMatteCache | null = matteCache
  ): Omit<SceneLayerDraw, "source" | "sourceWidth" | "sourceHeight" | "sourceVersion"> => {
    // Blur/glow are CSS filters in the DOM path — resolve the same params numerically and run them as
    // real GPU passes here (covers whole-clip AND region blur). NOT baked into the source raster.
    const fx = getCompositionFilterEffects(layer, { currentTimeSeconds: t });
    // Blur/glow radii are SPATIAL — the GPU blur kernel works in BACKING px (comp × renderScale). Scale the
    // comp-px radius by renderScale so the blur/bloom covers the same COMP distance at any playback resolution
    // (otherwise a Half/Quarter backing spreads it 1/renderScale× wider → washed out, the "no glow while
    // playing" bug). renderScale=1 (paused + export) is identity, so paused/gate/export are unchanged.
    const blurPx = fx.blurPx * rScale;
    const glow = fx.glow
      ? { radiusPx: fx.glow.radiusPx * rScale, color: parseCssColor(fx.glow.color), mode: fx.glow.mode, threshold: fx.glow.threshold, strength: fx.glow.strength }
      : null;
    const transform = getCompositionTransform(layer, { currentTimeSeconds: t });
    // Media clip masks are LAYER-ATTACHED (mask editor + DOM + Remotion all ride the layer
    // transform) — bake the resolved transform into the matte so the comp-fixed gl_FragCoord
    // sampling still lands the mask on the clip. Text/shape mattes stay comp-fixed (by design).
    const mask = mc
      ? mc.get(layer, Math.max(0, t - layer.startSeconds), {
          x: transform.x,
          y: transform.y,
          scale: transform.scale,
          rotation: transform.rotation,
          anchorX: transform.anchorX,
          anchorY: transform.anchorY,
        })
      : null;
    // Content transform (source-within-frame pan/zoom/crop). offsetX/Y (-1..1 frame fractions) → pan
    // ±0.5 frame; crop → [left, right, top, bottom]. null when identity so the compositor skips it.
    const ct = getCompositionContentTransform(layer, { currentTimeSeconds: t });
    const hasContent = ct.scale !== 1 || ct.offsetX !== 0 || ct.offsetY !== 0 || ct.crop.top > 0 || ct.crop.right > 0 || ct.crop.bottom > 0 || ct.crop.left > 0;
    return {
      debugLayerId: layer.id,
      fit: getCompositionObjectFit(layer),
      blendMode: getCompositionBlendMode(layer),
      // Opacity is applied LIVE here (the quad's uOpacity), NOT baked into the grade — so it's reactive
      // on a seek/pause (which recomposite but don't re-grade), exactly like position/scale and
      // text/shape. WebglMediaLayer grades this layer at opacity 1 (`bakeOpacity={false}` in VideoPreview).
      transform: { x: transform.x, y: transform.y, scale: transform.scale, rotation: transform.rotation, opacity: transform.opacity, anchorX: transform.anchorX, anchorY: transform.anchorY },
      // 3D tilt (Phase 4.1): the composite quad projects the comp box. Default 0 = flat (unchanged).
      // perspective/z scaled by renderScale so foreshortening is resolution-invariant (writeQuad works in
      // BACKING px); rScale=1 (paused + export) = identity. See the text branch for the full rationale.
      rotateX: transform.rotateX,
      rotateY: transform.rotateY,
      perspective: transform.perspective * rScale,
      z: transform.z * rScale,
      mask,
      blurPx,
      glow,
      content: hasContent
        ? { scale: ct.scale, pan: [ct.offsetX * 0.5, ct.offsetY * 0.5], crop: [ct.crop.left, ct.crop.right, ct.crop.top, ct.crop.bottom] }
        : null,
      maskVersion: mask ? mc?.versionOf(layer.id) : undefined,
    };
  };

  // Build the FULL `SceneLayerDraw` for one layer (object-fit/content + grade + blur/glow + mask + transform
  // + 3D). Used for normal layers AND for each side of a transition — so a transition mixes fully-rendered
  // clips and every per-clip effect is present DURING the transition, not just after it. Returns null when
  // the source/raster isn't ready yet.
  //
  // `dims` overrides the comp size + matte-cache instance a layer builds against — defaults to the outer
  // PARENT scope (today's exact behavior). A nested child (NESTING.md Phase C) is built against its NEST's
  // own size/matte-cache instead, since its `transform.x/y` percentages and text-raster layout are relative
  // to the nested comp, not the parent — see `buildGroupDraw` below.
  const buildLayerDraw = (
    layer: TimelineLayer,
    dims: { w: number; h: number; matteCache: SceneMaskMatteCache | null } = { w, h, matteCache }
  ): SceneLayerDraw | null => {
    frameProfiler.bump("build.layerDraw.calls"); // pure: rebuilds the SceneLayerDraw structure every call
    if (layer.type === "text" || layer.type === "shape") {
      // Text/shape: the raster is transform- AND grade-INDEPENDENT (4.1b), so the composite quad applies
      // position/scale/rotation/opacity while the grade/mask/3D fold in below (4.1c) — one cached raster is
      // reused across all of them. BOX mode (resolution-aware) rasterizes a tight element box at ~the
      // displayed scale so magnified text stays crisp; the quad scales that box. With a blur/glow effect we
      // use COMP mode (comp-sized raster) because the effect plate path stretches a tight box to the comp.
      const fx = getCompositionFilterEffects(layer, { currentTimeSeconds: t });
      const blurPx = fx.blurPx * rScale;
      const glow = fx.glow
        ? { radiusPx: fx.glow.radiusPx * rScale, color: parseCssColor(fx.glow.color), mode: fx.glow.mode, threshold: fx.glow.threshold, strength: fx.glow.strength }
        : null;
      const boxMode = !(fx.blurPx > 0 || glow);
      const raster = rasterizer?.get(layer, t, dims.w, dims.h, boxMode);
      if (!raster) {
        onLayerNotReady?.(layer.id); // not ready / empty — rAF re-draws once it lands
        return null;
      }
      const hasBox = raster.boxHalfW != null && raster.boxHalfH != null;
      const tr = getCompositionTransform(layer, { currentTimeSeconds: t });

      // 4.1c grade: run the UNGRADED raster through the per-layer MediaWebGLRenderer (LUT engine shared
      // with media + the export overlay path). The graded canvas becomes the source; since a keyframed
      // pipeline changes it every frame, it must always re-upload (sourceVersion undefined) — unlike the
      // static ungraded raster, which skips re-upload via its version.
      const pipeline = getCompositionColorPipeline(layer, { currentTimeSeconds: t });
      let source: TexImageSource | SceneTextureSource = raster.canvas;
      // Grading resizes the renderer canvas to the raster's dims, so these hold for graded + ungraded.
      const sourceW = raster.canvas.width;
      const sourceH = raster.canvas.height;
      let sourceVersion = rasterizer?.versionOf(layer.id);
      if (pipeline && !pipeline.identity) {
        const gradedCanvas = gradeOverlay(layer.id, raster.canvas, pipeline);
        if (gradedCanvas) {
          source = gradedCanvas;
          sourceVersion = undefined;
        }
      }

      // 4.1c clip-mask: the same comp-space alpha matte the media path uses (the compositor samples it in
      // comp space — correct for the element-box/tilted quad).
      const mask = dims.matteCache ? dims.matteCache.get(layer, Math.max(0, t - layer.startSeconds)) : null;

      return {
        debugLayerId: layer.id,
        source,
        sourceWidth: sourceW,
        sourceHeight: sourceH,
        fit: "fill",
        blendMode: getCompositionBlendMode(layer),
        transform: { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation, opacity: tr.opacity, anchorX: tr.anchorX, anchorY: tr.anchorY },
        // 4.1c 3D tilt: only in BOX mode, where the element box makes the perspective translate(-50%,-50%)
        // term correct. (blur/glow comp-mode keeps flat — tilt+blur on text is an uncommon combo.)
        // perspective/z are scaled by renderScale like the box half-extents: writeQuad projects in BACKING
        // px, so a fixed-logical-px perspective/z would change the foreshortening with playback resolution
        // (tilt looked weaker at Half/Quarter, stronger paused). rScale=1 (paused + export) = identity.
        ...(hasBox ? { rotateX: tr.rotateX, rotateY: tr.rotateY, perspective: tr.perspective * rScale, z: tr.z * rScale } : {}),
        mask,
        blurPx,
        glow,
        sourceVersion,
        maskVersion: mask ? dims.matteCache?.versionOf(layer.id) : undefined,
        // BOX mode: tight element box (comp px) → the quad scales THIS box, magnifying a near-display-res
        // raster. COMP mode (blur/glow): undefined → comp box. Box half-extents are logical comp px →
        // scale to the render backing (renderScale) like the comp box.
        box: hasBox ? { halfW: raster.boxHalfW! * rScale, halfH: raster.boxHalfH! * rScale } : undefined,
      };
    }

    // Media: graded canvas (color/matte baked, opacity NOT baked — `bakeOpacity=false`) + presentation
    // shared with a compound clip's `shell` (buildShellPresentation above). NEST-REVIEW: this recomputes
    // filter-effects/transform/content-transform a second time (buildShellPresentation does its own) for a
    // media layer — a small, pure, per-frame CPU recompute (not a GPU/alloc cost) traded for keeping
    // buildShellPresentation fully self-contained; flag if this ever shows up in a perf trace.
    const mediaSource = getMediaGraded(layer.id);
    if (!mediaSource || mediaSource.width === 0 || mediaSource.height === 0) {
      onLayerNotReady?.(layer.id);
      return null;
    }
    const presentation = buildShellPresentation(layer, dims.matteCache);
    return {
      ...presentation,
      source: mediaSource,
      sourceWidth: mediaSource.width,
      sourceHeight: mediaSource.height,
      // Media grade version: MediaWebGLRenderer stamps its producer record (`updatedAt`, a
      // performance.now() at the end of every draw()) — so a graded canvas that was NOT re-drawn
      // since the last composite skips its upload entirely. A playing video redraws per frame
      // (fresh version → uploads exactly as before), but a STATIC IMAGE overlay only redraws on
      // grade/effect changes — previously its FULL-RESOLUTION canvas (e.g. a 4180×2776 stock
      // photo ≈ 46MB) was texSubImage2D'd on EVERY composited frame, which froze low-end preview
      // whenever a photo clip was on screen (2026-07-03 report). No producer record (DOM fallback
      // canvases, exotic sources) → undefined → today's always-upload behavior.
      // A same-context texture carries its own version (S6.2); only an UPLOADED source is findable in
      // the producer WeakMap. Asking the map about a texture was the browser half of the dead cache.
      sourceVersion: isSceneTextureSource(mediaSource as never)
        ? (mediaSource as unknown as SceneTextureSource).version
        : getTexImageSourceProducerInfo(mediaSource as unknown as TexImageSource)?.updatedAt,
    };
  };

  // Pass model: clones grouped under their base, in ls (panel) order — each becomes one ordered pass.
  const clonesByBase = new Map<string, TimelineLayer[]>();
  if (regionPassModel) {
    for (const layer of ls) {
      const base = regionCloneBaseId(layer.id);
      if (!base) continue;
      const list = clonesByBase.get(base);
      if (list) list.push(layer);
      else clonesByBase.set(base, [layer]);
    }
  }

  /** Fold the region clones into passes on the base draw (see `regionPassModel` doc on the inputs).
   *  `mc` defaults to the parent `matteCache`; nested children (Task 2) pass their nest-specific instance. */
  const buildRegionPasses = (baseLayer: TimelineLayer, clones: TimelineLayer[], mc: SceneMaskMatteCache | null = matteCache): SceneRegionPass[] => {
    const baseEffectIds = new Set(baseLayer.effects.map((effect) => effect.id));
    const passes: SceneRegionPass[] = [];
    for (const clone of clones) {
      // The clone's effects are [globals shared with the base, its ONE region effect (mask-stripped)] — the
      // region effect is the id the base doesn't carry. The clone's own masks are the composed clip∩region
      // list, so the matte cache builds exactly the pass mask.
      const extra = clone.effects.filter((effect) => !baseEffectIds.has(effect.id));
      if (extra.length === 0) continue;
      // Region masks on a media clone ride the layer transform exactly like clip masks (the clone
      // shares the base layer's transform; see buildShellPresentation).
      const cloneTransform = getCompositionTransform(clone, { currentTimeSeconds: t });
      const mask = mc
        ? mc.get(clone, Math.max(0, t - clone.startSeconds), {
            x: cloneTransform.x,
            y: cloneTransform.y,
            scale: cloneTransform.scale,
            rotation: cloneTransform.rotation,
          })
        : null;
      if (!mask) continue;
      if (extra.every((effect) => effect.type === "blur")) {
        // BLUR pass: gaussian the RUNNING nest image masked to the region — combines with the base grade /
        // earlier passes, which clone stacking couldn't express.
        const fx = getCompositionFilterEffects({ ...clone, effects: extra }, { currentTimeSeconds: t });
        if (!(fx.blurPx > 0)) continue;
        passes.push({ effectKey: clone.id, mask, maskVersion: mc?.versionOf(clone.id), blurPx: fx.blurPx * rScale });
        continue;
      }
      // COLOR pass: the ONE region effect's own pipeline, applied to the RUNNING nest image in-compositor
      // (shared-context grade — no clone source, decoder, or graded canvas needed).
      const pipeline = getCompositionColorPipeline({ ...clone, effects: extra }, { currentTimeSeconds: t });
      if (!pipeline || pipeline.identity) continue;
      passes.push({ effectKey: clone.id, mask, maskVersion: mc?.versionOf(clone.id), pipeline });
    }
    return passes;
  };

  /**
   * Fold a layer's enabled `pluginShader` effects (real user GLSL "Custom Shader", Task 1.4) into ordered
   * `SceneFragmentPass`es, independent of the region-pass-model clone system (fragment effects don't need
   * `expandLayerEffectRegions` cascading — each is its own self-contained pass). A per-effect `masks` list,
   * when present, builds its own matte via the same `SceneMaskMatteCache` region blur/color passes use,
   * keyed by the effect's own id (never collides with the layer's or a region-clone's pool key). A missing
   * fragment definition (manifest never registered this session) skips the pass — never throws — and
   * records `window.__rfFragmentEffects` telemetry in dev.
   */
  const buildFragmentPasses = (layer: TimelineLayer, mc: SceneMaskMatteCache | null = matteCache): SceneFragmentPass[] => {
    frameProfiler.bump("build.fragmentPasses.calls"); // pure: no cache, rebuilds the pass list every call
    const passes: SceneFragmentPass[] = [];
    const layerTimeSeconds = Math.max(0, t - layer.startSeconds);
    for (const effect of layer.effects) {
      if (effect.enabled === false) continue;
      // "pluginShader" resolves its fragment definition through a user-registered manifest id;
      // the builtin fragment effects (radial/directional blur, sharpen, pixelate, chromatic
      // aberration — see `color/fragment-effects/builtins.ts`) map straight from the effect TYPE.
      const isBuiltinFragmentEffect = BUILTIN_FRAGMENT_EFFECT_TYPES.has(effect.type);
      if (effect.type !== "pluginShader" && !isBuiltinFragmentEffect) continue;
      const manifestId = isBuiltinFragmentEffect ? builtinFragmentEffectId(effect.type) : effect.params?.[SHADER_MANIFEST_ID_PARAM_KEY];
      const def = typeof manifestId === "string" ? getFragmentEffect(manifestId) : undefined;
      if (!def) {
        if (typeof window !== "undefined") {
          const dbg = ((window as { __rfFragmentEffects?: Record<string, unknown> }).__rfFragmentEffects ??= {});
          dbg[effect.id] = { manifestId, missing: true };
        }
        continue;
      }
      const rawParams = effect.params ?? {};
      const keyframeResolved: Record<string, TimelineEffectParamValue> = {};
      for (const [key, value] of Object.entries(rawParams)) {
        keyframeResolved[key] =
          typeof value === "number"
            ? evaluateTimelineEffectParam({ animations: layer.animations, baseValue: value, effectId: effect.id, paramKey: key, timeSeconds: layerTimeSeconds })
            : value;
      }
      const params = fragmentEffectParamsFromStorage(def, keyframeResolved);
      const hasMasks = Array.isArray(effect.masks) && effect.masks.length > 0;
      // Effect masks on MEDIA layers ride the layer transform like clip masks (same editor, same
      // semantics); text/shape masks stay comp-fixed.
      const overlayType = layer.type === "text" || layer.type === "shape";
      const fxT = hasMasks && !overlayType ? getCompositionTransform(layer, { currentTimeSeconds: t }) : null;
      const mask =
        hasMasks && mc
          ? mc.get(
              { id: effect.id, masks: effect.masks, animations: layer.animations } as TimelineLayer,
              layerTimeSeconds,
              fxT ? { x: fxT.x, y: fxT.y, scale: fxT.scale, rotation: fxT.rotation } : undefined
            )
          : null;
      passes.push({
        effectKey: effect.id,
        def,
        params,
        intensity: Math.max(0, Math.min(1, (effect.intensity ?? 100) / 100)),
        timeSeconds: t,
        mask: mask ?? undefined,
        maskVersion: mask && mc ? mc.versionOf(effect.id) : undefined,
      });
    }
    if (passes.length) frameProfiler.bump("build.fragmentPasses.emitted", passes.length);
    return passes;
  };

  /**
   * Flarex hook (FLAREX.md): the finished layer draw becomes the comp's MediaIn and the lowered graph
   * replaces it. Applied at the END of `buildLayerDrawWithPasses` so every consumer path (top-level,
   * transition sides, nested children, track-matte sources) gets comp output uniformly. A comp that
   * lowers to nothing (e.g. broken graph) falls back to the plain draw — soft degrade, never black.
   */
  const applyFlarex = (layer: TimelineLayer, draw: SceneLayerDraw | null, dims: { w: number; h: number; matteCache: SceneMaskMatteCache | null }): SceneLayerDraw | SceneGroupDraw | null => {
    if (!draw || !layer.flarexCompId) return draw;
    const comp = inputs.flarexComps?.[layer.flarexCompId];
    if (!comp) return draw;
    // COMP PROXY (plans/flarex-comp-proxy.md, S2): a pre-rendered frame of this comp replaces the whole
    // lowering. Built FRESH rather than spread from `draw` — the host's transform, opacity, blend, masks
    // and passes are all already baked into the proxy (this hook runs at the END of the layer's draw
    // build, so they fed the comp's MediaIn), and carrying them over would apply every one of them a
    // second time. Full-frame identity quad: the proxy IS the finished comp frame.
    const proxy = inputs.flarexCompProxies?.[layer.flarexCompId];
    if (proxy) {
      frameProfiler.bump("evaluator.proxyHits");
      return {
        debugLayerId: `${layer.id}__flarexproxy`,
        source: proxy.source,
        sourceWidth: proxy.sourceWidth,
        sourceHeight: proxy.sourceHeight,
        fit: "fill",
        transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
        blendMode: "normal",
        ...(proxy.sourceVersion === undefined ? {} : { sourceVersion: proxy.sourceVersion }),
      };
    }
    // Profiler-only: isolate compile-only time from the rest of buildSceneDraws (the gate metric — is the
    // Flarex evaluator actually the cost, or is the 3–5 ms generic build overhead?). No-op when disabled.
    const lowered = frameProfiler.measure("evaluator.compile", () => compileFlarexComp(comp, {
      compWidth: dims.w,
      compHeight: dims.h,
      renderScale: rScale,
      timeSeconds: Math.max(0, t - layer.startSeconds),
      frameTimeSeconds: t,
      hostSourceDraw: draw,
      matteCache: dims.matteCache,
      // Runtime-only materialization policy (Slice 1) — undefined in production (dormant); set only
      // by the parity gate. Never sourced from persisted graph/manifest data.
      materializeNodeIds: inputs.flarexMaterializeNodeIds,
      // Node previews (Slice 4): re-root this compile at an arbitrary node without disturbing the
      // comp's persisted view dot. Undefined in normal rendering.
      // Thumbnail scalar wins (it is explicitly re-rooting one comp); otherwise this comp's own live
      // view dot, if the viewer supplied one. Absent in export/worker → roots at MediaOut (I-26).
      previewRootNodeId: inputs.flarexPreviewRootNodeId ?? inputs.flarexPreviewRoots?.[comp.id],
      // Editor before/after wipe. Comp-space split, no object-fit conversion — see the option's docs.
      gradeCompare: inputs.flarexGradeCompare,
      // Degradation reporting (S0.2). Observability only; absent → the compiler is unchanged.
      onDegrade: inputs.onFlarexDegrade ? (degradation) => inputs.onFlarexDegrade!(comp.id, degradation) : undefined,
      // S6.4/S6.6 — comp id attached here, so a node id is never ambiguous across comps in one frame.
      onEvaluated: inputs.flarexOnEvaluated
        ? (nodeId, contextKey, value) => inputs.flarexOnEvaluated!(comp.id, nodeId, contextKey, value)
        : undefined,
      reuseValue: inputs.flarexReuseValue
        ? (nodeId, contextKey) => inputs.flarexReuseValue!(comp.id, nodeId, contextKey)
        : undefined,
      // Asset-source MediaIn (FLAREX.md Phase 2, Fusion Loader model): build the source draw from the
      // node's VIRTUAL loader (decoded off-timeline by the caller, addressed by comp+node id). Its
      // media is provided via `getMediaGraded(virtualId)` exactly like a real clip; an unready/absent
      // loader → null → MediaIn falls back to the host. Built against the HOST's comp dims.
      resolveSourceDraw: (nodeId) => {
        const virtual = flarexVirtualById.get(flarexVirtualLayerId(comp.id, nodeId));
        if (!virtual) return null;
        // The loader's `durationSeconds` is clamped to the source's own remaining length
        // (`collectFlarexVirtualLayers`). Once comp-local time passes it, the source has run out —
        // signal "ended" so the MediaIn goes transparent (leaving the background) instead of holding
        // the last frame to the end of the comp. `freeze`/image/unknown loaders never end (Infinity).
        const localT = Math.max(0, t - layer.startSeconds);
        if (localT >= virtual.durationSeconds) return "ended";
        // A loader EXISTS for this node, so the answer is its picture or "not yet" — never the host's.
        // `buildLayerDraw` returns null on exactly one relevant condition here: the graded canvas has
        // not landed. Reporting that as null let the compiler substitute `hostSourceDraw`, which under
        // a retime is a different MOMENT of the shot — the "same playhead, different host" flash
        // (2026-07-29). `"pending"` says whose it is and that it isn't ready.
        return cachedPreFlarexDraw(virtual, dims, comp.version ?? 0) ?? "pending";
      },
    }));
    return lowered ?? draw;
  };

  /** `buildLayerDraw` + the layer's folded region + fragment passes + track matte, but WITHOUT the Flarex
   *  hook — the plain, fully-built `SceneLayerDraw` a layer would emit if it had no comp. This is what a
   *  Flarex MediaIn pulls for a sibling clip (`resolveSourceDraw`, multi-clip MediaIn) — pulling the
   *  pre-Flarex draw means a referenced clip's OWN comp is never re-entered here, so cross-comp
   *  references can't recurse. `dims` threads through exactly like `buildLayerDraw`. */
  function buildLayerPreFlarexDraw(
    layer: TimelineLayer,
    dims: { w: number; h: number; matteCache: SceneMaskMatteCache | null } = { w, h, matteCache }
  ): SceneLayerDraw | null {
    frameProfiler.bump("build.preFlarex.calls"); // the Flarex source ADAPTER; time = compile.resolveSource
    if (!regionPassModel || regionCloneBaseId(layer.id)) {
      const draw = buildLayerDraw(layer, dims);
      if (draw) {
        const fragmentPasses = buildFragmentPasses(layer, dims.matteCache);
        if (fragmentPasses.length > 0) draw.fragmentPasses = fragmentPasses;
        attachTrackMatte(layer, draw, dims);
      }
      return draw;
    }
    let baseLayer = layer;
    let clones = clonesByBase.get(layer.id) ?? [];
    if (clones.length === 0 && hasRegionColorEffect(layer)) {
      // Caller passed UNEXPANDED layers (the pass model needs no upstream clones): derive the base + region
      // structure here with the SAME shared expansion the clone model uses, render-only.
      const expanded = expandLayerEffectRegions(layer);
      baseLayer = expanded[0] ?? layer;
      clones = expanded.slice(1);
    }
    const draw = buildLayerDraw(baseLayer, dims);
    if (!draw) return draw;
    const passes = buildRegionPasses(baseLayer, clones, dims.matteCache);
    if (passes.length > 0) draw.regionPasses = passes;
    const fragmentPasses = buildFragmentPasses(baseLayer, dims.matteCache);
    if (fragmentPasses.length > 0) draw.fragmentPasses = fragmentPasses;
    attachTrackMatte(layer, draw, dims);
    // Debug telemetry (window.__rf* convention): what the pass folding decided for this layer this frame.
    if (typeof window !== "undefined") {
      const dbg = ((window as { __rfRegionPasses?: Record<string, unknown> }).__rfRegionPasses ??= {});
      dbg[layer.id] = {
        clones: clones.map((clone) => clone.id),
        passes: passes.map((pass) => ({ key: pass.effectKey, blurPx: pass.blurPx, hasPipeline: Boolean(pass.pipeline) })),
      };
    }
    return draw;
  }

  /**
   * Cross-frame-cached `buildLayerPreFlarexDraw` for Flarex asset-source loaders. A BARE loader (identity
   * transform, no effects/masks/animation — every `collectFlarexVirtualLayers` output) has a time-invariant
   * draw STRUCTURE, so on a cache hit we reuse the immutable template and REBIND only the live media handle
   * (`source`/`sourceVersion`/size), skipping the full rebuild (`buildLayerDraw` + `getCompositionTransform`
   * + `buildFragmentPasses`). Byte-identical to the uncached path: the rebound media fields are exactly what
   * a fresh build would compute this frame. Not bare, or no cache supplied → full rebuild (unchanged path).
   */
  const cachedPreFlarexDraw = (
    virtual: TimelineLayer,
    dims: { w: number; h: number; matteCache: SceneMaskMatteCache | null },
    compVersion: number
  ): SceneLayerDraw | null => {
    const cache = inputs.flarexSourceDrawCache;
    const bare =
      (virtual.effects?.length ?? 0) === 0 &&
      (virtual.animations?.length ?? 0) === 0 &&
      (virtual.keyframes?.length ?? 0) === 0 &&
      (virtual.masks?.length ?? 0) === 0;
    // The cache's hit path rebinds the live MEDIA handle (`getMediaGraded`), so it only describes a
    // loader whose source IS decoded media. A GENERATOR loader (Text+/Background) is sourced from a
    // RASTER instead: it has no graded media, so a hit would rebind `null` and the node would vanish
    // after its first frame. It also gains nothing from the cache — the rasterizer already returns a
    // version-cached canvas, which is the same saving one level down. This is precisely the
    // "future non-bare loader falls back to a full rebuild" escape the cache documents.
    const mediaBacked = virtual.type === "video" || virtual.type === "image";
    if (!cache || !bare || !mediaBacked) {
      frameProfiler.bump("sourceDraw.uncached");
      return buildLayerPreFlarexDraw(virtual, dims);
    }
    const key = FlarexSourceDrawCache.key(virtual.id, compVersion, rScale);
    const template = cache.get(key);
    if (template) {
      // HIT: skip the rebuild; rebind only the per-frame-volatile media handle. If the source isn't ready
      // this frame, hold (return null → the same not-ready path a fresh build would take).
      const src = getMediaGraded(virtual.id);
      if (!src || src.width === 0 || src.height === 0) {
        onLayerNotReady?.(virtual.id);
        frameProfiler.bump("sourceDraw.hitNotReady");
        return null;
      }
      frameProfiler.bump("sourceDraw.hits");
      return {
        ...template,
        source: src,
        sourceWidth: src.width,
        sourceHeight: src.height,
        sourceVersion: getTexImageSourceProducerInfo(src as unknown as TexImageSource)?.updatedAt,
      };
    }
    // MISS: full build (already carries this frame's media), then cache the shallow-frozen template. The
    // built draw is returned directly; the Flarex compiler clones it (cloneImage) before any mutation, so
    // the cached template is never mutated in place.
    frameProfiler.bump("sourceDraw.misses");
    const built = buildLayerPreFlarexDraw(virtual, dims);
    if (built) cache.set(key, Object.freeze(built) as SceneLayerDraw);
    return built;
  };

  /** The pre-Flarex draw with the Flarex hook applied: a layer with a `flarexCompId` returns the LOWERED
   *  graph (possibly a group draw) instead of its plain draw; every other layer returns its plain draw
   *  unchanged. This is the normal per-layer entry point (top-level, transition sides, nested children,
   *  track-matte sources). */
  function buildLayerDrawWithPasses(
    layer: TimelineLayer,
    dims: { w: number; h: number; matteCache: SceneMaskMatteCache | null } = { w, h, matteCache }
  ): SceneLayerDraw | SceneGroupDraw | null {
    return applyFlarex(layer, buildLayerPreFlarexDraw(layer, dims), dims);
  }

  // ─── Nesting: fold __nest_ children into compound-clip GROUP draws (NESTING.md Phase C) ─────────────
  // Group ownership (`groupKeys`/`layerOwnerGroup`/`groupOwnerGroup`) is computed earlier, ahead of the
  // transition fold loop above (R2 fix), so it's already in scope here.
  // DIRECT leaf members per group, in `ls` (z) order. Transition-fold participants and pass-model region
  // clones are excluded here exactly like the top-level loop excludes them below.
  // NEST-REVIEW: a nested child that is itself mid-transition (child-to-child WITHIN a nest) is DROPPED
  // from its group in Block 1 rather than mixed — a graceful degrade (not a crash/double-draw), not full
  // support. `nesting.ts`'s own transition time-mapping (`mapTransitionSpec`) is unaffected and ready for
  // it; wiring recursive transition-folding into `buildGroupDraw`'s child loop (mirroring
  // `transitionOutgoingIds`/`foldedIds`/`activeByIncomingId` scoped per-group) is the natural follow-up.
  // Region-pass-model clones fold into their base's `regionPasses` exactly as outside a nest — no special
  // case needed since `buildLayerDrawWithPasses` already handles that uniformly for any layer id.
  const membersByGroup = new Map<string, TimelineLayer[]>();
  if (groupKeys.length > 0) {
    for (const layer of ls) {
      const owner = layerOwnerGroup.get(layer.id);
      if (!owner) continue;
      if (transitionOutgoingIds.has(layer.id) || foldedIds.has(layer.id)) continue;
      if (regionPassModel && regionCloneBaseId(layer.id)) continue;
      const list = membersByGroup.get(owner);
      if (list) list.push(layer);
      else membersByGroup.set(owner, [layer]);
    }
  }
  // DIRECT child group keys per PARENT group (top-level groups have owner `null` — see `topGroupKeyAtIndex`).
  const childGroupsByOwner = new Map<string, string[]>();
  for (const key of groupKeys) {
    const owner = groupOwnerGroup.get(key);
    if (!owner) continue;
    const list = childGroupsByOwner.get(owner);
    if (list) list.push(key);
    else childGroupsByOwner.set(owner, [key]);
  }
  // Position (index into `ls`) each group would occupy — the MIN of its direct members' indices and its
  // child groups' own positions, propagated bottom-up (deepest groups first, since an ancestor's position
  // depends on its children's). Depth = number of `__nest_` occurrences in the key (deeper = more).
  const layerIndex = new Map<string, number>();
  // Per-frame guard: `layerIndex` (an O(layers) Map fill) and the depth walk only feed group
  // positioning — with no nested groups every read below is a `.get() → undefined` no-op, so
  // skip building them entirely (they were pure per-frame GC churn for non-nested comps).
  if (groupKeys.length > 0) {
    ls.forEach((layer, i) => layerIndex.set(layer.id, i));
  }
  const countSeparators = (key: string): number => key.split(NEST_ID_SEPARATOR).length - 1;
  const groupKeysByDepthDesc = groupKeys.length > 0 ? [...groupKeys].sort((a, b) => countSeparators(b) - countSeparators(a)) : groupKeys;
  const groupFirstIndex = new Map<string, number>();
  for (const key of groupKeysByDepthDesc) {
    let min = Number.POSITIVE_INFINITY;
    for (const member of membersByGroup.get(key) ?? []) {
      const idx = layerIndex.get(member.id);
      if (idx !== undefined) min = Math.min(min, idx);
    }
    for (const childKey of childGroupsByOwner.get(key) ?? []) {
      const idx = groupFirstIndex.get(childKey);
      if (idx !== undefined) min = Math.min(min, idx);
    }
    groupFirstIndex.set(key, min);
  }
  // TOP-LEVEL groups only (owner === null) — the main loop below emits one at the `ls` index of its first
  // (transitive) member. A group with NO members anywhere (Infinity) never gets an index → never emitted,
  // matching `buildGroupDraw`'s own "zero ready children → null" degrade.
  const topGroupKeyAtIndex = new Map<number, string>();
  for (const key of groupKeys) {
    if (groupOwnerGroup.get(key)) continue; // has an owner → emitted INSIDE that ancestor, not top-level
    const idx = groupFirstIndex.get(key);
    if (idx !== undefined && Number.isFinite(idx)) topGroupKeyAtIndex.set(idx, key);
  }
  type GroupChildRef = { kind: "layer"; layer: TimelineLayer; pos: number } | { kind: "group"; key: string; pos: number };
  /** Ordered {layer | child-group} refs for one group's children, by their resolved position above. */
  const orderedGroupChildRefs = (key: string): GroupChildRef[] => {
    const refs: GroupChildRef[] = [];
    for (const member of membersByGroup.get(key) ?? []) {
      refs.push({ kind: "layer", layer: member, pos: layerIndex.get(member.id) ?? 0 });
    }
    for (const childKey of childGroupsByOwner.get(key) ?? []) {
      const pos = groupFirstIndex.get(childKey);
      if (pos !== undefined && Number.isFinite(pos)) refs.push({ kind: "group", key: childKey, pos });
    }
    refs.sort((a, b) => a.pos - b.pos);
    return refs;
  };
  // Per-nested-composition matte cache, lazily created/pooled in the caller-owned `nestMatteCaches` map
  // (mirrors `gradeRenderers`). Returns null (soft-degrade: nested masks just don't render) when the
  // caller hasn't wired the pool — see the `nestMatteCaches` doc on `BuildSceneDrawsInputs`.
  const matteCacheForNest = (nestedCompositionId: string, nestW: number, nestH: number): SceneMaskMatteCache | null => {
    if (!nestMatteCaches) return null;
    let mc = nestMatteCaches.get(nestedCompositionId);
    if (!mc) {
      mc = new SceneMaskMatteCache(nestW, nestH);
      nestMatteCaches.set(nestedCompositionId, mc);
    } else {
      mc.resize(nestW, nestH); // no-op if unchanged — one composition id's dims never change per-instance
    }
    return mc;
  };
  /**
   * Build one compound-clip GROUP draw (recursive — a child may itself be a group, nests-in-nests).
   * Children are built against the NESTED comp's OWN size/matte-cache (Task 2); the shell is built in
   * PARENT coordinates via `buildShellPresentation`, exactly like any other media layer's presentation.
   * Returns null when there are zero ready children (an empty/not-yet-ready nest renders as nothing, not
   * an error — NESTING.md's "duration is not live" overhang semantics) or the group spec is missing.
   */
  const buildGroupDraw = (key: string): SceneGroupDraw | null => {
    const spec = nestedGroups?.get(key);
    if (!spec) return null;
    const nestW = spec.composition.width;
    const nestH = spec.composition.height;
    const nestDims = { w: nestW, h: nestH, matteCache: matteCacheForNest(spec.composition.id, nestW, nestH) };
    const children: SceneDraw[] = [];
    const groupPairs = groupPairsByOwner.get(key);
    for (const ref of orderedGroupChildRefs(key)) {
      if (ref.kind === "group") {
        const child = buildGroupDraw(ref.key);
        if (child) children.push(child);
      } else {
        // A nested member consumed as a sibling's track matte never draws on its own (D1) — same
        // rule as the top-level loop's `matteSourceIds` skip.
        if (matteSourceIds.has(ref.layer.id)) continue;
        // R2 step 3 (D4): a child-to-child transition WITHIN this nest emits the mix at the incoming
        // child's z-slot — both sides built against the NEST's dims, exactly like the top-level fold.
        // The outgoing side never reaches this loop (it's in `transitionOutgoingIds`, excluded from
        // `membersByGroup`), so nothing double-draws. If a side isn't ready, fall through to drawing
        // the incoming child normally (the same degrade as the top-level branch).
        const pairEntry = groupPairs?.find((entry) => entry.incomingId === ref.layer.id);
        if (pairEntry) {
          const outgoingLayer = layerById.get(pairEntry.outgoingId);
          const from = outgoingLayer ? buildLayerDrawWithPasses(outgoingLayer, nestDims) : null;
          const to = buildLayerDrawWithPasses(ref.layer, nestDims);
          if (from && to) {
            children.push({
              kind: "transition",
              debugFromId: pairEntry.outgoingId,
              debugToId: pairEntry.incomingId,
              from: [from],
              to: [to],
              def: pairEntry.active.def,
              progress: pairEntry.active.progress,
              params: pairEntry.active.params,
            });
            continue;
          }
          if (to) children.push(to);
          continue;
        }
        const draw = buildLayerDrawWithPasses(ref.layer, nestDims);
        if (draw) children.push(draw);
      }
    }
    if (children.length === 0) return null;
    // Block 4a/4b (NESTING_MATURITY.md): the group clip's OWN color pipeline + region/fragment passes.
    // A compound clip mounts no WebglMediaLayer (nothing pre-grades its "media"), so its pipeline rides
    // the group draw and grades the finished nest RTT in-compositor; region effects never got upstream
    // `__rfx_` clones either (the compound clip is removed before `expandEffectRegionMasks` runs), so
    // derive them here with the same shared expansion `buildLayerDrawWithPasses` uses for unexpanded
    // layers — passes attach to the SHELL, which renders through the ordinary layer-draw path against
    // the PARENT matte cache. Clone model (regionPassModel off): group region effects stay a documented
    // degrade — the clone stack needs real upstream layers, which don't exist for a compound clip.
    let shellClip = spec.clip;
    let shellRegionPasses: SceneRegionPass[] = [];
    if (regionPassModel && hasRegionColorEffect(spec.clip)) {
      const expanded = expandLayerEffectRegions(spec.clip);
      shellClip = expanded[0] ?? spec.clip;
      shellRegionPasses = buildRegionPasses(shellClip, expanded.slice(1));
    }
    const shell = buildShellPresentation(shellClip);
    if (shellRegionPasses.length > 0) shell.regionPasses = shellRegionPasses;
    const shellFragmentPasses = buildFragmentPasses(shellClip);
    if (shellFragmentPasses.length > 0) shell.fragmentPasses = shellFragmentPasses;
    const pipeline = getCompositionColorPipeline(shellClip, { currentTimeSeconds: t });
    return {
      kind: "group",
      debugGroupId: key,
      children,
      nestWidth: Math.max(1, Math.round(nestW * rScale)),
      nestHeight: Math.max(1, Math.round(nestH * rScale)),
      shell,
      pipeline: pipeline && !pipeline.identity ? pipeline : null,
      groupKey: key,
    };
  };

  /**
   * Attach the consumer's resolved track-matte SOURCE draw (D1) to its finished layer draw. The
   * source is built against the SAME dims as the consumer (a nested consumer's source is a sibling in
   * the same nest); a compound-clip source pre-composes exactly like a top-level group draw. An
   * unresolved source stays `draw: null` — the compositor's EMPTY matte. Chained mattes recurse here
   * naturally (the source's own draw goes through `buildLayerDrawWithPasses` → its own attach);
   * termination is structural — a source is always strictly LATER in `ls` than its consumer.
   */
  const attachTrackMatte = (
    layer: TimelineLayer,
    draw: SceneLayerDraw,
    dims: { w: number; h: number; matteCache: SceneMaskMatteCache | null }
  ): void => {
    const tm = layer.trackMatte;
    if (!tm) return;
    const resolved = matteSourceByConsumer.get(layer.id) ?? null;
    let sourceDraw: SceneLayerDraw | SceneGroupDraw | null = null;
    if (resolved?.kind === "layer") sourceDraw = buildLayerDrawWithPasses(resolved.layer, dims);
    else if (resolved?.kind === "group") sourceDraw = buildGroupDraw(resolved.key);
    draw.matteFrom = { draw: sourceDraw, mode: tm.mode, invert: Boolean(tm.invert) };
  };

  /** One junction-transition side as draws (Block 4c): a compound clip pre-composes as its finished
   *  GROUP (children + shell + pipeline — every group feature renders THROUGH the mix); a normal clip
   *  stays the base + `__rfx_` clip group it always was. */
  const buildTransitionSide = (baseId: string): SceneDraw[] => {
    if (isGroupSide(baseId)) {
      const g = buildGroupDraw(baseId);
      return g ? [g] : [];
    }
    return buildClipGroup(baseId);
  };

  for (let i = 0; i < ls.length; i++) {
    const layer = ls[i]!;
    // Outgoing base + everything folded into an active transition's side groups is drawn INSIDE the mix, not
    // independently. The incoming BASE is not folded — it reaches the emit below.
    if (transitionOutgoingIds.has(layer.id)) continue;
    if (foldedIds.has(layer.id)) continue;
    // Track matte (D1): a consumed SOURCE clip (and its region-expansion clones) never draws
    // independently — its image lives on as the consumer's matte.
    const cloneBase = regionCloneBaseId(layer.id);
    if (matteSourceIds.has(layer.id) || (cloneBase !== null && matteSourceIds.has(cloneBase))) continue;
    // Pass model: clone layers never draw independently — they became passes on their base draw.
    if (regionPassModel && cloneBase) continue;
    // A TOP-LEVEL group is emitted once, at the `ls` index of its first (transitive) member — checked
    // BEFORE the "nested layer, never independent" skip below, because that index IS the position of one
    // of the group's own owned members (a member's z-slot IS the group's z-slot, by construction of
    // `groupFirstIndex`); checking the skip first would eat the group's only emission point.
    const topGroupKey = topGroupKeyAtIndex.get(i);
    if (topGroupKey) {
      // Track matte (D1): a compound clip consumed as a matte source never draws independently.
      if (!matteSourceGroupKeys.has(topGroupKey)) {
        // Block 4c: a compound clip consumed as an active junction's OUTGOING side draws inside the
        // mix (emitted at the incoming side's z-slot), never independently — the group analog of the
        // `transitionOutgoingIds` skip at the top of this loop.
        if (transitionOutgoingIds.has(topGroupKey)) continue;
        // Block 4c: the compound clip is the INCOMING side — emit the mix at the group's z-slot,
        // exactly like the layer branch below. Either side falling through un-ready degrades to
        // drawing the group normally (same degrade as the layer branch).
        const groupActive = activeByIncomingId.get(topGroupKey);
        if (groupActive) {
          const pair = transitionByIncomingId.get(topGroupKey)!;
          const from = buildTransitionSide(pair.outgoingId);
          const to = buildTransitionSide(pair.incomingId);
          if (from.length > 0 && to.length > 0) {
            draws.push({
              kind: "transition",
              debugFromId: pair.outgoingId,
              debugToId: pair.incomingId,
              from,
              to,
              def: groupActive.def,
              progress: groupActive.progress,
              params: groupActive.params,
            });
            continue;
          }
        }
        // Span gate (junction pre/post-roll extension in nesting.ts): derived children may exist
        // slightly OUTSIDE the compound clip's span to feed a transition mix with real material.
        // Outside the span AND outside a mix (the branches above), the group must not draw — a
        // pre-rolled incoming group would otherwise flash before its cut.
        const groupSpec = nestedGroups?.get(topGroupKey);
        if (groupSpec) {
          const clipStart = groupSpec.clip.startSeconds;
          const clipEnd = clipStart + groupSpec.clip.durationSeconds;
          if (t < clipStart - 1e-6 || t >= clipEnd + 1e-6) continue;
        }
        const g = buildGroupDraw(topGroupKey);
        if (g) draws.push(g);
      }
      continue;
    }
    // Nesting: a layer belonging to ANY compound-clip nest never emits independently — it was folded into
    // its group's `children` above (or gracefully dropped, per the NEST-REVIEW note there).
    if (layerOwnerGroup.has(layer.id)) continue;
    const active = activeByIncomingId.get(layer.id);
    if (active) {
      // Emit a folded transition: each side is the clip's WHOLE group (base + region-expansion layers), so
      // every per-clip effect renders THROUGH the transition. If a side has no ready draw, fall through to
      // drawing the incoming clip normally.
      const pair = transitionByIncomingId.get(layer.id)!;
      const from = buildTransitionSide(pair.outgoingId);
      const to = buildTransitionSide(pair.incomingId);
      if (from.length > 0 && to.length > 0) {
        draws.push({ kind: "transition", debugFromId: pair.outgoingId, debugToId: pair.incomingId, from, to, def: active.def, progress: active.progress, params: active.params });
        continue;
      }
    }
    const d = buildLayerDrawWithPasses(layer);
    if (d) draws.push(d);
  }
  // Prune grade renderers for layers no longer in the composition (bounds live WebGL contexts). Keyed on
  // layer presence, not per-frame grade state, so toggling a grade off doesn't thrash context creation.
  if (gradeRenderers.size > 0) {
    const liveIds = new Set(ls.map((layer) => layer.id));
    for (const [id, { renderer }] of gradeRenderers) {
      if (!liveIds.has(id)) {
        renderer.dispose();
        gradeRenderers.delete(id);
      }
    }
  }
  // Prune per-nest matte caches for nested compositions no longer referenced this frame (mirrors the
  // gradeRenderers prune above).
  if (nestMatteCaches && nestMatteCaches.size > 0) {
    const liveNestCompIds = new Set(nestedGroups ? [...nestedGroups.values()].map((spec) => spec.composition.id) : []);
    for (const [id, cache] of nestMatteCaches) {
      if (!liveNestCompIds.has(id)) {
        cache.dispose();
        nestMatteCaches.delete(id);
      }
    }
  }

  return draws;
}
