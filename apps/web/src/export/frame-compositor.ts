/**
 * Local export — frame compositor (media + color + text/shape + 3D tilt).
 *
 * Composites the visible layers for a given time onto a 2D canvas. Media runs through the shared
 * `MediaWebGLRenderer` (color LUT + vignette/grain/chroma — the SAME engine as the editor
 * preview); text/shape rasterize to canvas and, when graded, run through the same LUT. Placement
 * is the layer's center/scale/rotation/opacity + object-fit; layers with a 3D tilt
 * (rotateX/Y/perspective) are composited via the WebGL `Quad3DCompositor` instead of the 2D
 * affine path, since canvas 2D can't express perspective.
 */

import {
  MediaWebGLRenderer,
  TransitionCompositor,
  canvasBlendOp,
  findTransitionPairs,
  getActiveTransition,
  getCompositionBlendMode,
  getCompositionColorPipeline,
  isTrackEnabled,
  getCompositionMediaEffects,
  getCompositionObjectFit,
  getCompositionTransform,
  getCompositionTransition,
  getTransition,
  isRenderableMask,
  maskShapeToPathD,
  resolveMaskAtTime,
  type Mask,
  type MaskMode,
  type MediaTransition,
  type TimelineComposition,
  type TimelineLayer,
  type TransitionSpec,
} from "@reelforge/shared";
import type { FrameProvider } from "./source-decoder";
import { drawShapeLayer, drawTextLayer } from "./text-shape";
import { Quad3DCompositor, type Quad3DTransform } from "./quad-3d";

interface FlatLayer {
  layer: TimelineLayer;
  trackIndex: number;
  layerIndex: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type CompositionTransform = ReturnType<typeof getCompositionTransform>;

/** A layer is "3D" when it tilts (rotateX/Y) or is pushed in depth under a perspective. */
function has3DTilt(t: CompositionTransform): boolean {
  return Math.abs(t.rotateX) > 1e-3 || Math.abs(t.rotateY) > 1e-3 || (t.perspective > 0 && Math.abs(t.z) > 1e-3);
}

/**
 * Canvas2D compositing op per mask mode — the canvas equivalent of the `-webkit-mask-composite` used by the
 * DOM/SVG renderers (see getMaskCss). Here the running accumulation is the *destination* and the new mask is
 * the *source*, so unlike CSS the masks are composited in panel order (base first) with NO reversal:
 * Subtract = destination-out (keep accumulation, punch out this shape), Intersect = source-in, Exclude = xor.
 */
const MASK_GCO: Record<MaskMode, GlobalCompositeOperation> = {
  add: "source-over",
  subtract: "destination-out",
  intersect: "source-in",
  exclude: "xor"
};

/** Bounds center of a mask's points (matches the SVG `maskTransformAttr` rotate/scale pivot). */
function maskCenter(points: Mask["points"]): { x: number; y: number } {
  if (!points.length) return { x: 0, y: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

export class FrameCompositor {
  private readonly ctx: Ctx2D;
  private readonly width: number;
  private readonly height: number;
  private readonly flat: FlatLayer[];
  private readonly adjustments: FlatLayer[];
  private readonly renderers = new Map<string, MediaWebGLRenderer>();
  private readonly pipelineKeys = new Map<string, string>();
  // Full-size scratch surface used to rasterize a text/shape layer before grading it through
  // the WebGL LUT (so graded overlays use the SAME engine as media — no CSS/SVG filter).
  private overlayCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private overlayCtx: Ctx2D | null = null;
  // Lazily-created WebGL perspective-quad compositor, used only for 3D-tilted layers.
  private quad3d: Quad3DCompositor | null = null;
  // Lazily-created two-texture GPU transition compositor (unified transition engine).
  private transition: TransitionCompositor | null = null;
  private readonly flatById = new Map<string, FlatLayer>();

  constructor(
    private readonly composition: TimelineComposition,
    canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly getSource: (assetId: string) => FrameProvider | undefined
  ) {
    this.width = composition.width;
    this.height = composition.height;
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext("2d") as Ctx2D | null;
    if (!ctx) throw new Error("frame-compositor: 2D context unavailable");
    this.ctx = ctx;

    const flat: FlatLayer[] = [];
    composition.tracks.forEach((track, trackIndex) => {
      track.layers.forEach((layer, layerIndex) => flat.push({ layer, trackIndex, layerIndex }));
    });
    this.adjustments = flat.filter((f) => f.layer.type === "adjustment");
    // Match the web preview's stacking EXACTLY (VideoPreview.activeVisualLayerEntries): track 0
    // is the TOP track, so draw bottom→top — highest trackIndex first, ties by layerIndex asc.
    // Getting this wrong paints the base video over text/shape layers and hides them entirely.
    this.flat = flat
      .slice()
      .sort((a, b) => (a.trackIndex !== b.trackIndex ? b.trackIndex - a.trackIndex : a.layerIndex - b.layerIndex));
    for (const item of flat) this.flatById.set(item.layer.id, item);
  }

  /**
   * Effects from adjustment clips that sit above this layer and are active at `t`. Mirrors the
   * preview's `applyActiveAdjustmentEffects`: an adjustment affects layers on lower-in-the-stack
   * (higher-index) tracks, i.e. `adjustment.trackIndex < target.trackIndex`.
   */
  private mergedLayer(target: FlatLayer, t: number): TimelineLayer {
    const extra = this.adjustments
      .filter(
        (a) =>
          a.trackIndex < target.trackIndex &&
          t >= a.layer.startSeconds &&
          t < a.layer.startSeconds + a.layer.durationSeconds
      )
      .flatMap((a) => a.layer.effects);
    if (!extra.length) return target.layer;
    return { ...target.layer, effects: [...target.layer.effects, ...extra] };
  }

  /**
   * How long this clip must keep rendering past its out-point: the duration of the next same-track
   * clip's `transitionIn` (the transition window the outgoing clip is composited under). 0 if none.
   */
  private postrollSeconds(item: FlatLayer): number {
    const track = this.composition.tracks[item.trackIndex];
    if (!track) return 0;
    const end = item.layer.startSeconds + item.layer.durationSeconds;
    let best = 0;
    for (const other of track.layers) {
      if (other.id === item.layer.id || !other.transitionIn) continue;
      if (Math.abs(other.startSeconds - end) < 0.05) best = Math.max(best, other.transitionIn.durationSeconds);
    }
    return best;
  }

  /** A detached <canvas> on the main thread, or an OffscreenCanvas inside the export Worker. */
  private makeCanvas(): HTMLCanvasElement | OffscreenCanvas {
    return typeof document !== "undefined"
      ? document.createElement("canvas")
      : new OffscreenCanvas(this.width, this.height);
  }

  private rendererFor(id: string): MediaWebGLRenderer {
    let renderer = this.renderers.get(id);
    if (!renderer) {
      renderer = new MediaWebGLRenderer(this.makeCanvas());
      this.renderers.set(id, renderer);
    }
    return renderer;
  }

  private quad3dCompositor(): Quad3DCompositor {
    this.quad3d ??= new Quad3DCompositor(this.width, this.height, this.makeCanvas());
    return this.quad3d;
  }

  private transitionCompositor(): TransitionCompositor {
    this.transition ??= new TransitionCompositor(this.makeCanvas());
    return this.transition;
  }

  /**
   * Fetch, matte, and color-grade a media layer's frame at `timeSeconds` into its `MediaWebGLRenderer`,
   * returning the graded canvas + source dimensions (or null if no frame yet). Shared by the normal
   * composite path and the two-clip transition mix. `transition` is the legacy single-texture reveal
   * (null when the layer is mixed through the unified engine).
   */
  private async gradeMediaLayer(
    item: FlatLayer,
    timeSeconds: number,
    transition: MediaTransition | null
  ): Promise<{ canvas: HTMLCanvasElement | OffscreenCanvas; sw: number; sh: number } | null> {
    const { layer } = item;
    if (!layer.assetId) return null;
    const source = this.getSource(layer.assetId);
    if (!source) return null;

    const sourceTime = layer.type === "video" ? (layer.sourceInSeconds ?? 0) + (timeSeconds - layer.startSeconds) : 0;
    const frame = await source.getFrame(sourceTime);
    if (!frame || source.width === 0 || source.height === 0) return null;

    let matteFrame: CanvasImageSource | null = null;
    if (layer.matte?.uri) {
      const matteSource = this.getSource(`matte:${layer.id}`);
      if (matteSource) {
        const mf = await matteSource.getFrame(sourceTime);
        if (mf && matteSource.width > 0) matteFrame = mf;
      }
    }

    const merged = this.mergedLayer(item, timeSeconds);
    const pipeline = getCompositionColorPipeline(merged, { currentTimeSeconds: timeSeconds });
    const mediaEffects = getCompositionMediaEffects(merged, { currentTimeSeconds: timeSeconds });

    const renderer = this.rendererFor(layer.id);
    const pipelineKey = JSON.stringify(pipeline);
    if (this.pipelineKeys.get(layer.id) !== pipelineKey) {
      renderer.setPipeline(pipeline);
      this.pipelineKeys.set(layer.id, pipelineKey);
    }
    renderer.draw({
      source: frame as TexImageSource,
      sourceWidth: source.width,
      sourceHeight: source.height,
      matte: matteFrame as TexImageSource | null,
      matteInvert: layer.matte?.invert ?? false,
      matteOpacity: layer.matte?.opacity ?? 1,
      pipeline,
      amount: 1,
      opacity: 1,
      mediaEffects,
      transition,
    });
    return { canvas: renderer.canvas, sw: source.width, sh: source.height };
  }

  /**
   * Composite a flat (un-rotated, un-scaled) comp-size layer buffer onto the frame with a real
   * 3D transform via WebGL, then drawImage the result. `transform` carries the full CSS tilt;
   * opacity is already baked into `buffer`. `boxW`/`boxH` are the ELEMENT box size in comp px —
   * the quad projects only that box (text/shape: their own size; media: the full comp).
   */
  private place3D(
    buffer: HTMLCanvasElement | OffscreenCanvas,
    transform: CompositionTransform,
    boxW: number,
    boxH: number
  ): void {
    const t: Quad3DTransform = {
      centerX: (transform.x / 100) * this.width,
      centerY: (transform.y / 100) * this.height,
      halfWidth: boxW / 2,
      halfHeight: boxH / 2,
      scale: transform.scale,
      rotation: transform.rotation,
      rotateX: transform.rotateX,
      rotateY: transform.rotateY,
      perspective: transform.perspective,
      z: transform.z,
    };
    const quad = this.quad3dCompositor();
    quad.draw(buffer as TexImageSource, t);
    this.ctx.drawImage(quad.canvas, 0, 0);
  }

  /** Lazily-created full-size transparent 2D surface for rasterizing graded/tilted layers. */
  private overlayContext(): Ctx2D {
    if (!this.overlayCtx) {
      const canvas = this.makeCanvas();
      canvas.width = this.width;
      canvas.height = this.height;
      const ctx = canvas.getContext("2d") as Ctx2D | null;
      if (!ctx) throw new Error("frame-compositor: overlay 2D context unavailable");
      this.overlayCanvas = canvas;
      this.overlayCtx = ctx;
    }
    return this.overlayCtx;
  }

  // Comp-sized scratch surfaces for vector masking (matte build + per-shape + invert + masked-media buffer),
  // created lazily and reused across frames. Keyed so each role keeps its own canvas.
  private readonly scratchCanvases = new Map<string, Ctx2D>();
  private scratchCtx(name: string): Ctx2D {
    let ctx = this.scratchCanvases.get(name);
    if (!ctx) {
      const canvas = this.makeCanvas();
      canvas.width = this.width;
      canvas.height = this.height;
      const c = canvas.getContext("2d") as Ctx2D | null;
      if (!c) throw new Error("frame-compositor: scratch 2D context unavailable");
      ctx = c;
      this.scratchCanvases.set(name, ctx);
    }
    return ctx;
  }

  /**
   * Rasterize a single mask's alpha matte (white = reveal, transparent = hide) into a comp-sized scratch
   * canvas, baking the mask's own transform, feather, expansion and invert — the canvas analogue of the
   * per-mask `<filter>` in buildMaskDefsSvg. Opacity is applied later, at the matte-composite step. Returns
   * the context whose `.canvas` holds the matte, or null when the shape is empty.
   */
  private renderMaskAlpha(mask: Mask): Ctx2D | null {
    const d = maskShapeToPathD(mask);
    if (!d) return null;
    const w = this.width;
    const h = this.height;
    const sctx = this.scratchCtx("maskShape");
    sctx.clearRect(0, 0, w, h);
    sctx.save();
    // Mask transform (translate → rotate@center → scale@center), matching maskTransformAttr.
    const c = maskCenter(mask.points);
    const t = mask.transform;
    if (t.x || t.y) sctx.translate(t.x, t.y);
    if (t.rotation) {
      sctx.translate(c.x, c.y);
      sctx.rotate((t.rotation * Math.PI) / 180);
      sctx.translate(-c.x, -c.y);
    }
    if (t.scaleX !== 1 || t.scaleY !== 1) {
      sctx.translate(c.x, c.y);
      sctx.scale(t.scaleX, t.scaleY);
      sctx.translate(-c.x, -c.y);
    }
    // Feather = Gaussian blur of the stencil; stdDeviation = feather/2 to match the SVG feGaussianBlur.
    sctx.filter = mask.feather > 0 ? `blur(${mask.feather / 2}px)` : "none";
    const path = new Path2D(d);
    sctx.fillStyle = "#fff";
    sctx.fill(path);
    // Expansion (approximate feMorphology): grow with a fill+stroke, shrink by erasing an edge stroke.
    if (mask.expansion > 0) {
      sctx.lineJoin = "round";
      sctx.lineWidth = mask.expansion * 2;
      sctx.strokeStyle = "#fff";
      sctx.stroke(path);
    } else if (mask.expansion < 0) {
      sctx.globalCompositeOperation = "destination-out";
      sctx.lineJoin = "round";
      sctx.lineWidth = -mask.expansion * 2;
      sctx.strokeStyle = "#fff";
      sctx.stroke(path);
    }
    sctx.restore();

    if (!mask.inverted) return sctx;
    // Invert = full-frame white MINUS the (feathered) shape → opaque outside, transparent inside.
    const ictx = this.scratchCtx("maskInvert");
    ictx.clearRect(0, 0, w, h);
    ictx.fillStyle = "#fff";
    ictx.fillRect(0, 0, w, h);
    ictx.globalCompositeOperation = "destination-out";
    ictx.drawImage(sctx.canvas, 0, 0);
    ictx.globalCompositeOperation = "source-over";
    return ictx;
  }

  /**
   * Build the combined alpha matte for a layer's clip masks at `tLocal` (layer-local seconds), or null when
   * the layer has no renderable masks. Masks composite in panel order (base first), each onto the running
   * matte by its mode via {@link MASK_GCO}; per-mask opacity scales its contribution. Returns the matte ctx.
   */
  private buildMaskMatte(layer: TimelineLayer, tLocal: number): Ctx2D | null {
    const masks = (layer.masks ?? []).filter(isRenderableMask);
    if (!masks.length) return null;
    const mctx = this.scratchCtx("maskMatte");
    mctx.clearRect(0, 0, this.width, this.height);
    masks.forEach((raw, index) => {
      const mask = resolveMaskAtTime(raw, layer.animations, tLocal);
      const shape = this.renderMaskAlpha(mask);
      if (!shape) return;
      mctx.globalAlpha = Math.max(0, Math.min(1, mask.opacity / 100));
      mctx.globalCompositeOperation = index === 0 ? "source-over" : MASK_GCO[mask.mode];
      mctx.drawImage(shape.canvas, 0, 0);
    });
    mctx.globalAlpha = 1;
    mctx.globalCompositeOperation = "source-over";
    return mctx;
  }

  /**
   * Draw a text/shape layer. Two enhancements over a plain 2D draw, both WebGL (no CSS filter):
   *   - color grade (own effects or an adjustment clip above) → rasterize then run the LUT;
   *   - 3D tilt → rasterize FLAT (no rotation/scale) then place via the perspective quad.
   * With neither active it draws straight onto the main canvas (the fast path).
   */
  private async drawOverlayLayer(item: FlatLayer, t: number): Promise<void> {
    const { layer } = item;
    const merged = this.mergedLayer(item, t);
    const pipeline = getCompositionColorPipeline(merged, { currentTimeSeconds: t });
    const graded = Boolean(pipeline && !pipeline.identity);
    const transform = getCompositionTransform(merged, { currentTimeSeconds: t });
    const tilted = has3DTilt(transform);

    // Fast path: no grade, no tilt — draw with the full 2D transform straight onto the frame.
    if (!graded && !tilted) {
      if (layer.type === "text") {
        await drawTextLayer(this.ctx, layer, t, this.width, this.height);
      } else {
        drawShapeLayer(this.ctx, layer, t, this.width, this.height);
      }
      return;
    }

    // Rasterize to the scratch buffer. Tilted layers render FLAT so the quad owns the transform;
    // grade-only layers keep their full 2D transform baked in.
    const mode = tilted ? "flat" : "full";
    const scratch = this.overlayContext();
    scratch.clearRect(0, 0, this.width, this.height);
    const box =
      layer.type === "text"
        ? await drawTextLayer(scratch, layer, t, this.width, this.height, mode)
        : drawShapeLayer(scratch, layer, t, this.width, this.height, mode);
    if (!this.overlayCanvas) return;

    // Color-grade through the LUT if needed; the result becomes the buffer to place.
    let buffer: HTMLCanvasElement | OffscreenCanvas = this.overlayCanvas;
    if (graded) {
      const renderer = this.rendererFor(layer.id);
      const pipelineKey = JSON.stringify(pipeline);
      if (this.pipelineKeys.get(layer.id) !== pipelineKey) {
        renderer.setPipeline(pipeline);
        this.pipelineKeys.set(layer.id, pipelineKey);
      }
      renderer.draw({
        source: this.overlayCanvas as TexImageSource,
        sourceWidth: this.width,
        sourceHeight: this.height,
        matte: null,
        pipeline,
        amount: 1,
        opacity: 1,
        mediaEffects: null,
      });
      buffer = renderer.canvas;
    }

    if (tilted) {
      // Pass the REAL element box — the CSS translate(-50%,-50%) term in the projection depends
      // on it. quad-3d adds its own render-only padding for stroke/shadow coverage.
      if (box.boxW > 0 && box.boxH > 0) this.place3D(buffer, transform, box.boxW, box.boxH);
    } else {
      this.ctx.drawImage(buffer, 0, 0);
    }
  }

  /** Render the composition at `timeSeconds` onto the 2D canvas. Returns the canvas. */
  async renderFrame(timeSeconds: number): Promise<void> {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = this.composition.backgroundColor || "#000000";
    ctx.fillRect(0, 0, this.width, this.height);

    // Track enable/solo: skip layers whose track is muted/hidden or silenced by another track's solo.
    const disabledTrackIds = new Set(
      this.composition.tracks.filter((t) => !isTrackEnabled(t, this.composition.tracks)).map((t) => t.id)
    );

    // Unified GPU transition engine: same-track pairs whose junction transition is active right now.
    // The mix is composited at the incoming clip's z-slot; the outgoing is skipped (folded into the mix).
    const allLayers = this.composition.tracks.flatMap((t) => t.layers);
    const incomingPairs = new Map<string, { outgoingId: string; spec: TransitionSpec; startSeconds: number }>();
    const transitionOutgoingIds = new Set<string>();
    for (const pair of findTransitionPairs(allLayers)) {
      const incoming = this.flatById.get(pair.incomingId)?.layer;
      if (!incoming || !this.flatById.has(pair.outgoingId)) continue;
      const active = getActiveTransition(pair.spec, { currentTimeSeconds: timeSeconds, startSeconds: incoming.startSeconds });
      if (!active) continue;
      incomingPairs.set(pair.incomingId, { outgoingId: pair.outgoingId, spec: pair.spec, startSeconds: incoming.startSeconds });
      transitionOutgoingIds.add(pair.outgoingId);
    }

    for (const item of this.flat) {
      const { layer } = item;
      if (disabledTrackIds.has(layer.trackId)) continue;
      // Active in its own span, or rendering into the post-roll of the next clip's transition (the
      // outgoing clip stays visible under the incoming reveal, playing its tail handle / a held frame).
      const postroll = this.postrollSeconds(item);
      if (timeSeconds < layer.startSeconds || timeSeconds >= layer.startSeconds + layer.durationSeconds + postroll) continue;

      // Blend mode: how this layer composites over what's already drawn (reset after each composite).
      const blendOp = canvasBlendOp(getCompositionBlendMode(layer));

      if (layer.type === "text" || layer.type === "shape") {
        ctx.globalCompositeOperation = blendOp as GlobalCompositeOperation;
        await this.drawOverlayLayer(item, timeSeconds);
        ctx.globalCompositeOperation = "source-over";
        continue;
      }
      if (layer.type !== "video" && layer.type !== "image") continue; // audio/adjustment

      // Transition incoming clip → grade both sides plainly, mix in one GPU pass, composite filling the
      // comp box (per-clip object-fit/transform is suspended during the transition, matching the preview).
      const pairInfo = incomingPairs.get(layer.id);
      if (pairInfo) {
        const def = getTransition(pairInfo.spec.kind);
        const outgoingItem = this.flatById.get(pairInfo.outgoingId);
        if (def && outgoingItem) {
          const active = getActiveTransition(pairInfo.spec, { currentTimeSeconds: timeSeconds, startSeconds: pairInfo.startSeconds });
          const fromGraded = await this.gradeMediaLayer(outgoingItem, timeSeconds, null);
          const toGraded = await this.gradeMediaLayer(item, timeSeconds, null);
          if (active && fromGraded && toGraded) {
            try {
              const compositor = this.transitionCompositor();
              compositor.draw(def, {
                from: fromGraded.canvas as TexImageSource,
                to: toGraded.canvas as TexImageSource,
                width: this.width,
                height: this.height,
                transitionId: active.transitionId,
                progress: active.progress,
                params: active.params,
                fromFit: getCompositionObjectFit(outgoingItem.layer) as "cover" | "contain" | "fill",
                toFit: getCompositionObjectFit(layer) as "cover" | "contain" | "fill",
              });
              ctx.globalCompositeOperation = blendOp as GlobalCompositeOperation;
              ctx.drawImage(compositor.canvas, 0, 0, this.width, this.height);
              ctx.globalCompositeOperation = "source-over";
              continue;
            } catch {
              // Shader failed to compile/draw — fall back to showing the incoming clip plainly below.
            }
          }
        }
      }
      // Outgoing side of an active pair is folded into the mix above — don't draw it on its own.
      if (transitionOutgoingIds.has(layer.id)) continue;

      const transition = getCompositionTransition(layer, { currentTimeSeconds: timeSeconds });
      const graded = await this.gradeMediaLayer(item, timeSeconds, transition);
      if (!graded) continue;

      const merged = this.mergedLayer(item, timeSeconds);
      const transform = getCompositionTransform(merged, { currentTimeSeconds: timeSeconds });
      const fit = getCompositionObjectFit(merged);
      const centerX = (transform.x / 100) * this.width;
      const centerY = (transform.y / 100) * this.height;
      const alpha = Math.max(0, Math.min(1, transform.opacity / 100));

      if (has3DTilt(transform)) {
        // Flat-place the graded frame (object-fit + opacity, no rotation/scale) into a comp
        // buffer, then let the WebGL quad apply the full 3D transform.
        const buffer = this.overlayContext();
        buffer.clearRect(0, 0, this.width, this.height);
        buffer.save();
        buffer.globalAlpha = alpha;
        buffer.translate(centerX, centerY);
        this.drawWithObjectFit(buffer, graded.canvas, graded.sw, graded.sh, fit);
        buffer.restore();
        // Media's element box is the full comp (object-fit fills it).
        ctx.globalCompositeOperation = blendOp as GlobalCompositeOperation;
        if (this.overlayCanvas) this.place3D(this.overlayCanvas, transform, this.width, this.height);
        ctx.globalCompositeOperation = "source-over";
        continue;
      }

      // Vector clip masks: render the layer's media into a comp-space buffer (element-local box), punch it
      // with the combined mask matte (destination-in), then composite the masked buffer under the layer
      // transform — so the mask follows the clip exactly like the CSS mask on the transformed DOM element.
      const matte = this.buildMaskMatte(layer, Math.max(0, timeSeconds - layer.startSeconds));
      if (matte) {
        const buf = this.scratchCtx("maskBuffer");
        buf.clearRect(0, 0, this.width, this.height);
        buf.save();
        buf.translate(this.width / 2, this.height / 2);
        this.drawWithObjectFit(buf, graded.canvas, graded.sw, graded.sh, fit);
        buf.restore();
        buf.save();
        buf.globalCompositeOperation = "destination-in";
        buf.drawImage(matte.canvas, 0, 0);
        buf.restore();

        ctx.save();
        ctx.globalCompositeOperation = blendOp as GlobalCompositeOperation;
        ctx.globalAlpha = alpha;
        ctx.translate(centerX, centerY);
        ctx.rotate((transform.rotation * Math.PI) / 180);
        ctx.scale(transform.scale, transform.scale);
        ctx.drawImage(buf.canvas, -this.width / 2, -this.height / 2);
        ctx.restore();
        continue;
      }

      // globalCompositeOperation is part of the canvas state, so save() captures it and restore() reverts
      // it to source-over — the blend applies only to this layer's draw.
      ctx.save();
      ctx.globalCompositeOperation = blendOp as GlobalCompositeOperation;
      ctx.globalAlpha = alpha;
      ctx.translate(centerX, centerY);
      ctx.rotate((transform.rotation * Math.PI) / 180);
      ctx.scale(transform.scale, transform.scale);
      this.drawWithObjectFit(ctx, graded.canvas, graded.sw, graded.sh, fit);
      ctx.restore();
    }
  }

  /** Draw `img` (a graded source) into the W×H composition box centered at the origin of `ctx`. */
  private drawWithObjectFit(ctx: Ctx2D, img: CanvasImageSource, sw: number, sh: number, fit: string) {
    const boxW = this.width;
    const boxH = this.height;
    const x0 = -boxW / 2;
    const y0 = -boxH / 2;

    if (fit === "fill") {
      ctx.drawImage(img, x0, y0, boxW, boxH);
      return;
    }

    const scale = fit === "contain" ? Math.min(boxW / sw, boxH / sh) : Math.max(boxW / sw, boxH / sh);
    const drawW = sw * scale;
    const drawH = sh * scale;
    const dx = -drawW / 2;
    const dy = -drawH / 2;

    if (fit === "cover") {
      // Crop overflow to the composition box.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, boxW, boxH);
      ctx.clip();
      ctx.drawImage(img, dx, dy, drawW, drawH);
      ctx.restore();
    } else {
      ctx.drawImage(img, dx, dy, drawW, drawH);
    }
  }

  dispose() {
    for (const renderer of this.renderers.values()) {
      try {
        renderer.dispose();
      } catch {
        /* ignore */
      }
    }
    this.renderers.clear();
    try {
      this.quad3d?.dispose();
    } catch {
      /* ignore */
    }
    this.quad3d = null;
    try {
      this.transition?.dispose();
    } catch {
      /* ignore */
    }
    this.transition = null;
    this.scratchCanvases.clear();
  }
}
