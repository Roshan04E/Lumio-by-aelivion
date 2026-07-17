/**
 * Comp-sized clip-mask alpha matte builder for the single GPU compositor (Method 3, Phase 1).
 *
 * The DOM preview applies clip masks via CSS `mask-image`; the SceneCompositor instead multiplies a
 * comp-sized alpha matte into the layer in-shader. This builds that matte on a 2D scratch canvas: masks
 * composite in panel order, each onto the running matte by its mode (`MASK_GCO`), with per-mask
 * feather/expansion/invert/transform/opacity. Both the editor preview (`ScenePreviewCanvas`) and the local
 * export (`SceneFrameCompositor`) go through the SceneCompositor, so this is the single clip-mask matte
 * path for both — Phase 5 folded export onto the SceneCompositor and retired the old canvas2D copy.
 */

import { isRenderableMask, maskShapeToPathD, resolveMaskAtTime } from "../clip-masks";
import { frameClipMask } from "../frames";
import type { Mask, MaskMode, TimelineLayer } from "../types";
import { makeCanvas2D, type AnyCanvas2D, type Ctx2D } from "./canvas-2d";

const MASK_GCO: Record<MaskMode, GlobalCompositeOperation> = {
  add: "source-over",
  subtract: "destination-out",
  intersect: "source-in",
  exclude: "xor",
};

function maskCenter(points: Mask["points"]): { x: number; y: number } {
  if (!points.length) return { x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * The LAYER transform a media matte must ride (see `get`): center position in percent of comp
 * (50/50 = centered), uniform scale, rotation in degrees — the same resolved values the composite
 * quad uses. Text/shape layers pass none (their masks are comp-fixed by design).
 */
export interface MatteLayerTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** Anchor point (D3): rotate/scale pivot, percent of the element box. Absent = 50/50 = center —
   *  the historical math, byte-identical. Must match the composite quad's pivot or a mask on an
   *  anchored clip lands somewhere other than where it was drawn. */
  anchorX?: number | undefined;
  anchorY?: number | undefined;
}

function renderMaskAlpha(
  ctx: Ctx2D,
  invertCtx: Ctx2D,
  mask: Mask,
  w: number,
  h: number,
  layerT?: MatteLayerTransform,
): Ctx2D | null {
  const d = maskShapeToPathD(mask);
  if (!d) return null;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  // MEDIA masks are layer-attached (AE/Premiere semantics): the DOM path puts the mask CSS on the
  // TRANSFORMED comp-sized element and the mask editor maps handles through the layer transform, so
  // the matte must ride it too (it used to be comp-fixed here — the one outlier — which made a mask
  // on any moved/scaled graphic clip somewhere other than where it was drawn). Same math as
  // MaskEditorOverlay.toComp: translate(center) · rotate · scale · translate(-comp/2).
  const layerScale = layerT ? layerT.scale || 1 : 1;
  if (layerT) {
    ctx.translate((layerT.x / 100) * w, (layerT.y / 100) * h);
    if (layerT.rotation) ctx.rotate((layerT.rotation * Math.PI) / 180);
    ctx.scale(layerScale, layerScale);
    // Anchor (D3): the pivot is the anchor point of the element box (default 50/50 = -w/2,-h/2 —
    // the historical center pivot), matching writeQuad/compositionTransformCss.
    ctx.translate(-((layerT.anchorX ?? 50) / 100) * w, -((layerT.anchorY ?? 50) / 100) * h);
  }
  const c = maskCenter(mask.points);
  const t = mask.transform;
  if (t.x || t.y) ctx.translate(t.x, t.y);
  if (t.rotation) {
    ctx.translate(c.x, c.y);
    ctx.rotate((t.rotation * Math.PI) / 180);
    ctx.translate(-c.x, -c.y);
  }
  if (t.scaleX !== 1 || t.scaleY !== 1) {
    ctx.translate(c.x, c.y);
    ctx.scale(t.scaleX, t.scaleY);
    ctx.translate(-c.x, -c.y);
  }
  const path = new Path2D(d);
  // Build the CRISP shape first (fill + expansion, NO blur). Feather is applied afterwards as an
  // edge-preserving pass — see below.
  ctx.fillStyle = "#fff";
  ctx.fill(path);
  if (mask.expansion > 0) {
    ctx.lineJoin = "round";
    ctx.lineWidth = mask.expansion * 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke(path);
  } else if (mask.expansion < 0) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineJoin = "round";
    ctx.lineWidth = -mask.expansion * 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke(path);
  }
  // Feather = a SYMMETRIC soft alpha ramp across the mask edge (the professional/AE behavior): blur the CRISP
  // (already fill+expansion) shape and REPLACE the matte with it. Applying the blur to the rasterized expanded
  // shape (not to each draw op, and not by eroding the base path) means expansion is respected and no hollow
  // ring can form. Note this is inherently a trade-off, not a bug: a Gaussian of a BOUNDED region loses peak
  // alpha once the radius nears the shape size, so a feather that is LARGE relative to the shape turns most of
  // it into a gradient (softer / more translucent) — exactly as in every NLE. A solid interior AND a soft
  // symmetric edge cannot coexist when feather ≳ shape size; use a smaller feather for a crisp core.
  if (mask.feather > 0) {
    // Feather rides the layer scale like the DOM path (where the feathered SVG filter is baked in
    // element-local px and the whole masked element is then CSS-scaled). The blur below runs in
    // device space (post-restore), so the layer scale must be folded in manually.
    const r = (mask.feather / 2) * layerScale;
    ctx.restore(); // pop the transform; ctx now holds the crisp shape rasterized in device space
    invertCtx.clearRect(0, 0, w, h);
    invertCtx.save();
    invertCtx.filter = `blur(${r}px)`;
    invertCtx.drawImage(ctx.canvas, 0, 0);
    invertCtx.restore();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(invertCtx.canvas, 0, 0); // symmetric feathered edge
  } else {
    ctx.restore();
  }

  if (!mask.inverted) return ctx;
  invertCtx.clearRect(0, 0, w, h);
  invertCtx.fillStyle = "#fff";
  invertCtx.fillRect(0, 0, w, h);
  invertCtx.globalCompositeOperation = "destination-out";
  invertCtx.drawImage(ctx.canvas, 0, 0);
  invertCtx.globalCompositeOperation = "source-over";
  return invertCtx;
}

function makeCtx(w: number, h: number): Ctx2D {
  const canvas = makeCanvas2D(w, h);
  const ctx = canvas.getContext("2d") as Ctx2D | null;
  if (!ctx) throw new Error("scene-mask-matte: 2D context unavailable");
  return ctx;
}

/**
 * Per-layer clip-mask matte builder + cache for the scene compositor.
 *
 * Two reasons this is a class, not a free function:
 *   1. **Correctness** — each layer needs its OWN matte canvas. The old shared-scratch builder returned
 *      one canvas for every layer, so multiple masked layers in a frame clobbered each other.
 *   2. **Perf** — the matte (canvas2D rasterization + feather blur) is rebuilt ONLY when the resolved
 *      masks change (keyframe/track animation), keyed below; static masks build once and reuse.
 */
export class SceneMaskMatteCache {
  // Transient scratch shared across layers (used only within a single build).
  private shape: Ctx2D;
  private invert: Ctx2D;
  // One matte canvas per layer (pooled), plus its cache key (the resolved-mask signature).
  private readonly pool = new Map<string, Ctx2D>();
  private readonly keys = new Map<string, string>();
  // Per-layer content version, bumped on each rebuild, so the compositor can skip re-uploading an
  // unchanged matte (an 8 MP comp-sized canvas) every frame.
  private readonly versions = new Map<string, number>();
  private w: number;
  private h: number;

  constructor(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.shape = makeCtx(width, height);
    this.invert = makeCtx(width, height);
  }

  resize(width: number, height: number): void {
    if (this.w === width && this.h === height) return;
    this.w = width;
    this.h = height;
    this.shape = makeCtx(width, height);
    this.invert = makeCtx(width, height);
    this.pool.clear();
    this.keys.clear();
    this.versions.clear();
  }

  /**
   * The layer's clip-mask matte at `tLocal` (layer-local seconds), rebuilt only on change, or null.
   * `layerTransform` (media layers only — pass none for text/shape): the layer's resolved
   * position/scale/rotation, baked into the matte so the mask follows the clip like every other
   * renderer; keyed below, so an animated transform rebuilds per change.
   */
  get(layer: TimelineLayer, tLocal: number, layerTransform?: MatteLayerTransform): AnyCanvas2D | null {
    // Frames (see FRAMES.md): a `layer.frame` is the BASE clip mask (index 0 = source-over below),
    // inscribed in the comp box, so framed media clips through this same matte the DOM/export share.
    const frameMask = frameClipMask(layer, { width: this.w, height: this.h });
    const masks = [...(frameMask ? [frameMask] : []), ...(layer.masks ?? [])].filter(isRenderableMask);
    if (!masks.length) {
      this.keys.delete(layer.id);
      this.versions.delete(layer.id);
      return null;
    }
    const resolved = masks.map((raw) => resolveMaskAtTime(raw, layer.animations, tLocal));
    const key = JSON.stringify([
      resolved.map((m) => [maskShapeToPathD(m), m.feather, m.expansion, m.opacity, m.mode, m.inverted, m.transform]),
      layerTransform ? [layerTransform.x, layerTransform.y, layerTransform.scale, layerTransform.rotation] : null,
    ]);
    const pooled = this.pool.get(layer.id);
    if (pooled && this.keys.get(layer.id) === key) return pooled.canvas as AnyCanvas2D;

    const mctx = pooled ?? makeCtx(this.w, this.h);
    if (!pooled) this.pool.set(layer.id, mctx);
    mctx.clearRect(0, 0, this.w, this.h);
    resolved.forEach((mask, index) => {
      const shape = renderMaskAlpha(this.shape, this.invert, mask, this.w, this.h, layerTransform);
      if (!shape) return;
      mctx.globalAlpha = Math.max(0, Math.min(1, mask.opacity / 100));
      mctx.globalCompositeOperation = index === 0 ? "source-over" : MASK_GCO[mask.mode];
      mctx.drawImage(shape.canvas, 0, 0);
    });
    mctx.globalAlpha = 1;
    mctx.globalCompositeOperation = "source-over";
    this.keys.set(layer.id, key);
    this.versions.set(layer.id, (this.versions.get(layer.id) ?? 0) + 1); // matte rebuilt → bump version
    return mctx.canvas as AnyCanvas2D;
  }

  /** Content version of the layer's currently-cached matte, for the compositor's skip-upload check. */
  versionOf(layerId: string): number | undefined {
    return this.versions.get(layerId);
  }

  dispose(): void {
    this.pool.clear();
    this.keys.clear();
    this.versions.clear();
  }
}
