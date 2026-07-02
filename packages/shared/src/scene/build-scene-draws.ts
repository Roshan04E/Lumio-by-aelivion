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

import { MediaWebGLRenderer } from "../color/media-renderer";
import type { ColorPipeline } from "../color/types";
import type { SceneDraw, SceneLayerDraw, SceneTextureSource } from "../color/scene-compositor";
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
import type { TimelineLayer, TransitionSpec } from "../types";
import type { SceneMaskMatteCache } from "./scene-mask-matte";
import type { SceneTextRasterizer } from "./scene-text-raster";

/** A `<canvas>` (main thread) or `OffscreenCanvas` (export Worker) — the pooled grade/transition surfaces. */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

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
  const buildClipGroup = (baseId: string): SceneLayerDraw[] => {
    const group: SceneLayerDraw[] = [];
    for (const layer of ls) {
      if (layer.id === baseId || regionCloneBaseId(layer.id) === baseId) {
        const draw = buildLayerDraw(layer);
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

  // Build the FULL `SceneLayerDraw` for one layer (object-fit/content + grade + blur/glow + mask + transform
  // + 3D). Used for normal layers AND for each side of a transition — so a transition mixes fully-rendered
  // clips and every per-clip effect is present DURING the transition, not just after it. Returns null when
  // the source/raster isn't ready yet.
  const buildLayerDraw = (layer: TimelineLayer): SceneLayerDraw | null => {
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

    if (layer.type === "text" || layer.type === "shape") {
      // Text/shape: the raster is transform- AND grade-INDEPENDENT (4.1b), so the composite quad applies
      // position/scale/rotation/opacity while the grade/mask/3D fold in below (4.1c) — one cached raster is
      // reused across all of them. BOX mode (resolution-aware) rasterizes a tight element box at ~the
      // displayed scale so magnified text stays crisp; the quad scales that box. With a blur/glow effect we
      // use COMP mode (comp-sized raster) because the effect plate path stretches a tight box to the comp.
      const boxMode = !(fx.blurPx > 0 || glow);
      const raster = rasterizer?.get(layer, t, w, h, boxMode);
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
      const mask = matteCache ? matteCache.get(layer, Math.max(0, t - layer.startSeconds)) : null;

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
        maskVersion: mask ? matteCache?.versionOf(layer.id) : undefined,
        // BOX mode: tight element box (comp px) → the quad scales THIS box, magnifying a near-display-res
        // raster. COMP mode (blur/glow): undefined → comp box. Box half-extents are logical comp px →
        // scale to the render backing (renderScale) like the comp box.
        box: hasBox ? { halfW: raster.boxHalfW! * rScale, halfH: raster.boxHalfH! * rScale } : undefined,
      };
    }

    // Media: graded canvas (color/matte baked, opacity NOT baked — `bakeOpacity=false`) + object-fit +
    // clip mask + transform.
    const mediaSource = getMediaGraded(layer.id);
    if (!mediaSource || mediaSource.width === 0 || mediaSource.height === 0) return null;
    const transform = getCompositionTransform(layer, { currentTimeSeconds: t });
    const mask = matteCache ? matteCache.get(layer, Math.max(0, t - layer.startSeconds)) : null;
    // Content transform (source-within-frame pan/zoom/crop). offsetX/Y (-1..1 frame fractions) → pan
    // ±0.5 frame; crop → [left, right, top, bottom]. null when identity so the compositor skips it.
    const ct = getCompositionContentTransform(layer);
    const hasContent = ct.scale !== 1 || ct.offsetX !== 0 || ct.offsetY !== 0 || ct.crop.top > 0 || ct.crop.right > 0 || ct.crop.bottom > 0 || ct.crop.left > 0;
    return {
      debugLayerId: layer.id,
      source: mediaSource,
      sourceWidth: mediaSource.width,
      sourceHeight: mediaSource.height,
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
      // Media's graded canvas changes every frame → leave sourceVersion undefined (always re-upload,
      // but via texSubImage2D — no realloc). The static clip-mask matte skips re-upload via its version.
      maskVersion: mask ? matteCache?.versionOf(layer.id) : undefined,
    };
  };

  for (const layer of ls) {
    // Outgoing base + everything folded into an active transition's side groups is drawn INSIDE the mix, not
    // independently. The incoming BASE is not folded — it reaches the emit below.
    if (transitionOutgoingIds.has(layer.id)) continue;
    if (foldedIds.has(layer.id)) continue;
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
    const d = buildLayerDraw(layer);
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

  return draws;
}
