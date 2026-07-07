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
import { MediaWebGLRenderer } from "../color/media-renderer";
import type { ColorPipeline } from "../color/types";
import type { SceneDraw, SceneGroupDraw, SceneLayerDraw, SceneRegionPass, SceneTextureSource } from "../color/scene-compositor";
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
import { expandLayerEffectRegions, hasRegionColorEffect } from "../clip-masks";
import { NEST_ID_SEPARATOR, type NestedGroupSpec } from "../nesting";
import type { TimelineLayer, TransitionSpec } from "../types";
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
  fromFit: "cover" | "contain" | "fill";
  toFit: "cover" | "contain" | "fill";
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
}

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
    layers: ls,
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
  } = inputs;

  // Layer lookup so a transition can build each side as a FULL layer draw (effects included).
  const layerById = new Map(ls.map((layer) => [layer.id, layer]));

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
  for (const pair of tPairs) {
    const active = getActiveTransition(pair.spec, {
      currentTimeSeconds: t,
      startSeconds: pair.startSeconds,
      clipDurationSeconds: layerById.get(pair.incomingId)?.durationSeconds,
    });
    if (!active || !layerById.has(pair.outgoingId) || !layerById.has(pair.incomingId)) {
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
  // A clip's group as ordered (back-to-front) layer draws: base + its region-expansion layers, dropping any
  // whose source/raster isn't ready. The compositor renders these into the side RTT in order, then mixes.
  // Pass model: the clones ARE the base draw's `regionPasses`, so the group collapses to the single base draw.
  const buildClipGroup = (baseId: string): SceneLayerDraw[] => {
    const group: SceneLayerDraw[] = [];
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
    const key = JSON.stringify(pipeline);
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
    const mask = mc ? mc.get(layer, Math.max(0, t - layer.startSeconds)) : null;
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
      transform: { x: transform.x, y: transform.y, scale: transform.scale, rotation: transform.rotation, opacity: transform.opacity },
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
      if (!raster) return null; // not ready / empty — rAF re-draws once it lands
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
        transform: { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation, opacity: tr.opacity },
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
    if (!mediaSource || mediaSource.width === 0 || mediaSource.height === 0) return null;
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
      sourceVersion: getTexImageSourceProducerInfo(mediaSource as unknown as TexImageSource)?.updatedAt,
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
      const mask = mc ? mc.get(clone, Math.max(0, t - clone.startSeconds)) : null;
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

  /** `buildLayerDraw`, plus the layer's folded region passes when the pass model is on. `dims` threads
   *  through to both (see `buildLayerDraw`'s doc) — nested children (Task 2) pass their nest's size/matte. */
  function buildLayerDrawWithPasses(
    layer: TimelineLayer,
    dims: { w: number; h: number; matteCache: SceneMaskMatteCache | null } = { w, h, matteCache }
  ): SceneLayerDraw | null {
    if (!regionPassModel || regionCloneBaseId(layer.id)) return buildLayerDraw(layer, dims);
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

  // ─── Nesting: fold __nest_ children into compound-clip GROUP draws (NESTING.md Phase C) ─────────────
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
  for (const layer of ls) {
    const owner = layerOwnerGroup.get(layer.id);
    if (!owner) continue;
    if (transitionOutgoingIds.has(layer.id) || foldedIds.has(layer.id)) continue;
    if (regionPassModel && regionCloneBaseId(layer.id)) continue;
    const list = membersByGroup.get(owner);
    if (list) list.push(layer);
    else membersByGroup.set(owner, [layer]);
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
  ls.forEach((layer, i) => layerIndex.set(layer.id, i));
  const countSeparators = (key: string): number => key.split(NEST_ID_SEPARATOR).length - 1;
  const groupKeysByDepthDesc = [...groupKeys].sort((a, b) => countSeparators(b) - countSeparators(a));
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
    for (const ref of orderedGroupChildRefs(key)) {
      if (ref.kind === "group") {
        const child = buildGroupDraw(ref.key);
        if (child) children.push(child);
      } else {
        const draw = buildLayerDrawWithPasses(ref.layer, nestDims);
        if (draw) children.push(draw);
      }
    }
    if (children.length === 0) return null;
    return {
      kind: "group",
      debugGroupId: key,
      children,
      nestWidth: Math.max(1, Math.round(nestW * rScale)),
      nestHeight: Math.max(1, Math.round(nestH * rScale)),
      shell: buildShellPresentation(spec.clip),
    };
  };

  for (let i = 0; i < ls.length; i++) {
    const layer = ls[i]!;
    // Outgoing base + everything folded into an active transition's side groups is drawn INSIDE the mix, not
    // independently. The incoming BASE is not folded — it reaches the emit below.
    if (transitionOutgoingIds.has(layer.id)) continue;
    if (foldedIds.has(layer.id)) continue;
    // Pass model: clone layers never draw independently — they became passes on their base draw.
    if (regionPassModel && regionCloneBaseId(layer.id)) continue;
    // A TOP-LEVEL group is emitted once, at the `ls` index of its first (transitive) member — checked
    // BEFORE the "nested layer, never independent" skip below, because that index IS the position of one
    // of the group's own owned members (a member's z-slot IS the group's z-slot, by construction of
    // `groupFirstIndex`); checking the skip first would eat the group's only emission point.
    const topGroupKey = topGroupKeyAtIndex.get(i);
    if (topGroupKey) {
      const g = buildGroupDraw(topGroupKey);
      if (g) draws.push(g);
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
      const from = buildClipGroup(pair.outgoingId);
      const to = buildClipGroup(pair.incomingId);
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
