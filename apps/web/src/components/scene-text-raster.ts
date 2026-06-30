/**
 * Text/shape rasterization + cache for the single GPU compositor (Method 3, Phase 4).
 *
 * Text and shape layers can't be sampled as a texture the way media can — they must be rasterized
 * first. We reuse the EXACT canvas rasterizers the local export uses (`drawTextLayer`/`drawShapeLayer`
 * in apps/web/src/export/text-shape.ts), so the scene path renders text/shape **identically to the
 * export** (the parity that matters once the DOM text engine is retired). The resulting comp-aspect
 * canvas is fed to the `SceneCompositor` as a `fit:"fill"`, identity-transform layer — so blend,
 * opacity, blur and glow all reuse the Phase-2 plate passes for free.
 *
 * Rasterizing every frame would be costly, so each layer's raster is CACHED and only rebuilt when its
 * content/style/transform actually changes (the key below). Static text — captions held on a segment,
 * a title card — rasterizes once and reuses its canvas during playback. Text rasterizes async (warp +
 * fonts); a stale canvas is returned until the fresh one lands (the rAF loop re-draws), and a
 * `document.fonts` listener bumps a version so text re-rasterizes once webfonts finish loading.
 *
 * Rasters are 2× the comp resolution for anti-aliasing (the comp-res accumulator downsamples them with
 * LINEAR filtering). Opacity/transform are baked by mode "full"; blur/glow are NOT baked (the compositor
 * applies them), so changing a blur amount does not invalidate the raster.
 */

import {
  drawShapeLayer,
  drawTextLayer,
  measureOverlayBox,
  overlayOverhangMargin,
} from "../export/text-shape";
import {
  getCompositionShapeStyle,
  getCompositionTextStyle,
  getCompositionTransform,
  getVisibleTextRuns,
  type TimelineLayer,
} from "@reelforge/shared";
import { makeCanvas2D, type AnyCanvas2D, type Ctx2D } from "../scene/canvas-2d";

// Comp-mode raster resolution (1×). The scene accumulator is comp-res and the EXPORT's drawTextLayer
// also draws at 1× comp-res, so 1× here keeps scene == export AND avoids an 8 MP raster. Used for the
// blur/glow comp-mode path (see `rasterize`); the no-effect path uses the resolution-aware BOX mode below.
const SCENE_TEXT_DPR = 1;

// Resolution-aware BOX mode: rasterize a tight element box at ~the displayed scale so magnified text
// stays crisp (like the export), instead of magnifying a 1× comp raster. The displayed scale is
// QUANTIZED to power-of-two buckets so a scale animation re-rasters only at bucket boundaries (~log2(N)
// times), not every frame — re-introducing the transform dependence 4.1b removed, but controlled.
// `bucket = clamp(ceil(log2(max(1, displayScale))), 0, MAX_RASTER_BUCKET)`, `rasterScale = 2^bucket`,
// then capped so (box+margin)*rasterScale never exceeds MAX_RASTER_DIM (bounds VRAM + stays under the
// GPU max texture size; extreme zoom is then sharper-but-bounded, not pixel-perfect).
const MAX_RASTER_BUCKET = 5; // 2^5 = 32× before the dim cap takes over
const MAX_RASTER_DIM = 4096; // safe across GPUs; ≤ typical MAX_TEXTURE_SIZE

/** A rasterized text/shape ready to composite. `boxHalfW/H` (comp px) size the composite quad's element
 *  box in BOX mode; omitted in comp mode (the caller uses the comp box). */
export interface SceneRaster {
  canvas: AnyCanvas2D;
  boxHalfW?: number | undefined;
  boxHalfH?: number | undefined;
}

// Composite/transform-derived CSS fields that `getCompositionText/ShapeStyle` embeds but the "content"
// raster does NOT bake (it draws comp-centered, untransformed; the composite quad + GPU passes apply
// them). They must be stripped from the cache key or a transform/opacity/blend animation re-rasterizes
// every frame. Keep only the content/font fields that change the drawn pixels.
const TRANSFORM_DERIVED_STYLE_FIELDS = ["left", "top", "transform", "opacity", "mixBlendMode", "filter"] as const;
function contentStyleForKey(style: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k in style) {
    if (!(TRANSFORM_DERIVED_STYLE_FIELDS as readonly string[]).includes(k)) out[k] = style[k];
  }
  return out;
}

interface RasterEntry {
  key: string;
  /** Pooled canvas reused across this layer's re-rasters (no per-frame alloc); null = empty box. */
  canvas: AnyCanvas2D | null;
  /** Composite-quad element-box half-extents (comp px) for BOX mode; undefined = comp box (comp mode). */
  boxHalfW: number | undefined;
  boxHalfH: number | undefined;
}

/** A cache entry → the `SceneRaster` the caller composites (null when the layer rasterized empty). */
function result(entry: RasterEntry): SceneRaster | null {
  return entry.canvas ? { canvas: entry.canvas, boxHalfW: entry.boxHalfW, boxHalfH: entry.boxHalfH } : null;
}

/** Per-`SceneCompositor`/preview instance: owns the raster cache and a webfont-ready version. */
export class SceneTextRasterizer {
  private readonly cache = new Map<string, RasterEntry>();
  // One reusable canvas per layer (pooled) so re-rastering animated text doesn't churn allocations/GC.
  private readonly pool = new Map<string, { canvas: AnyCanvas2D; ctx: Ctx2D; w: number; h: number }>();
  // Per-layer content version, bumped whenever a NEW raster lands in `cache`. The compositor's texture
  // cache reads this to skip re-uploading a static raster (the pooled canvas keeps the same identity).
  private readonly versions = new Map<string, number>();
  // At most one raster in flight per layer, so the pooled canvas is never drawn into concurrently.
  private readonly inFlight = new Set<string>();
  private fontsVersion = 0;
  private fontsTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  // Debounced so a burst of webfont loads triggers ONE version bump (one re-raster wave), not N.
  private readonly onFonts = () => {
    if (this.fontsTimer) clearTimeout(this.fontsTimer);
    this.fontsTimer = setTimeout(() => {
      this.fontsVersion += 1;
      this.fontsTimer = null;
    }, 150);
  };

  /** @param onReady called when an async raster lands, so the caller can re-arm its draw loop. */
  constructor(private readonly onReady?: () => void) {
    if (typeof document !== "undefined" && (document as Document).fonts) {
      const fonts = (document as Document).fonts;
      fonts.ready.then(this.onFonts).catch(() => undefined);
      fonts.addEventListener?.("loadingdone", this.onFonts);
    }
  }

  /**
   * Key capturing everything that changes the RASTER. The raster is drawn transform-INDEPENDENT (mode
   * "content": comp-centered, no position/scale/rotation/opacity), so the key must EXCLUDE the transform
   * — a transform animation then reuses one cached raster (the composite quad applies the transform).
   *
   * `getCompositionText/ShapeStyle` EMBEDS the transform as CSS (`left`/`top`/`transform`/`opacity`) plus
   * the blend/effect filters, so the raw style object still changes every frame under a transform
   * animation. We strip those composite-only fields ({@link contentStyleForKey}) and key on the
   * content/font fields only — otherwise the cache misses every frame (the perf bug 4.1b is meant to kill).
   */
  private keyFor(layer: TimelineLayer, t: number, width: number, height: number, bucket: number, boxMode: boolean): string {
    // `bucket` (the quantized display scale) + `boxMode` MUST be in the key: a bucket change is a
    // deliberate re-raster (resolution-aware), and box vs comp mode produce different rasters. The raw
    // (continuous) scale is still EXCLUDED — only the bucket — so within a bucket the raster is reused.
    if (layer.type === "text") {
      const runs = getVisibleTextRuns(layer, t).map((r) => [r.text, r.color, r.fontSizeMultiplier]);
      const style = contentStyleForKey(getCompositionTextStyle(layer, { currentTimeSeconds: t }) as Record<string, unknown>);
      // textWarp is NOT part of getCompositionTextStyle (it's a vector overlay, not a CSS style), so it
      // MUST be in the key explicitly — otherwise applying/changing warp doesn't invalidate the cached
      // raster and the stale plain text persists (drawTextLayer renders warp, returns early — no double).
      return JSON.stringify(["text", width, height, bucket, boxMode, this.fontsVersion, runs, style, layer.textWarp ?? null]);
    }
    const style = contentStyleForKey(getCompositionShapeStyle(layer, { currentTimeSeconds: t }) as Record<string, unknown>);
    return JSON.stringify(["shape", width, height, bucket, boxMode, this.fontsVersion, style]);
  }

  /** Power-of-two bucket of the layer's displayed scale at `t` (the resolution-aware re-raster step). */
  private bucketFor(layer: TimelineLayer, t: number): number {
    const scale = getCompositionTransform(layer, { currentTimeSeconds: t }).scale;
    const b = Math.ceil(Math.log2(Math.max(1, scale)));
    return Math.max(0, Math.min(MAX_RASTER_BUCKET, Number.isFinite(b) ? b : 0));
  }

  // A tiny persistent canvas used only to MEASURE the element box (layout / measureText) before sizing
  // the real raster canvas — measureText is independent of canvas size, so 1×1 suffices.
  private measureScratch: { ctx: Ctx2D } | null = null;
  private measureCtx(): Ctx2D {
    if (!this.measureScratch) {
      const c = makeCanvas2D(1, 1);
      const ctx = c.getContext("2d") as Ctx2D | null;
      if (!ctx) throw new Error("scene-text-raster: measure 2D context unavailable");
      this.measureScratch = { ctx };
    }
    return this.measureScratch.ctx;
  }

  /** Reuse (or lazily create / resize) this layer's pooled canvas, cleared and ready to draw at 2× DPI. */
  private poolCanvas(layerId: string, width: number, height: number): { canvas: AnyCanvas2D; ctx: Ctx2D } {
    const w = Math.max(1, Math.round(width * SCENE_TEXT_DPR));
    const h = Math.max(1, Math.round(height * SCENE_TEXT_DPR));
    let entry = this.pool.get(layerId);
    if (!entry || entry.w !== w || entry.h !== h) {
      const canvas = entry?.canvas ?? makeCanvas2D(w, h);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d") as Ctx2D | null;
      if (!ctx) throw new Error("scene-text-raster: 2D context unavailable");
      entry = { canvas, ctx, w, h };
      this.pool.set(layerId, entry);
    } else {
      entry.ctx.setTransform(1, 0, 0, 1, 0, 0);
      entry.ctx.clearRect(0, 0, w, h);
    }
    entry.ctx.setTransform(SCENE_TEXT_DPR, 0, 0, SCENE_TEXT_DPR, 0, 0);
    return { canvas: entry.canvas, ctx: entry.ctx };
  }

  /**
   * Return the layer's rasterized canvas to composite NOW. On a cache miss a fresh raster is kicked off
   * (async for text, serialized one-per-layer); the previous (stale) canvas is returned until it lands,
   * or null if there is none yet. A null `canvas` field means the layer rasterized empty — caller skips.
   */
  get(layer: TimelineLayer, t: number, width: number, height: number, boxMode = false): SceneRaster | null {
    if (this.disposed || width <= 0 || height <= 0) return null;
    const bucket = boxMode ? this.bucketFor(layer, t) : 0;
    const key = this.keyFor(layer, t, width, height, bucket, boxMode);
    const existing = this.cache.get(layer.id);
    if (existing && existing.key === key) return result(existing);

    // Miss → start a raster, unless one is already in flight for this layer (serialize → pooled canvas
    // is never written concurrently). Return the stale entry meanwhile (with ITS OWN box, not the pending
    // one — the composite quad must match the canvas it's actually drawing); the rAF loop re-draws.
    if (!this.inFlight.has(layer.id)) {
      this.inFlight.add(layer.id);
      void this.rasterize(layer, t, width, height, bucket, boxMode)
        .then((raster) => {
          if (this.disposed) return;
          this.cache.set(layer.id, { key, canvas: raster?.canvas ?? null, boxHalfW: raster?.boxHalfW, boxHalfH: raster?.boxHalfH });
          this.versions.set(layer.id, (this.versions.get(layer.id) ?? 0) + 1); // new content → bump version
          this.onReady?.(); // a fresh raster landed — re-arm the caller's draw loop so it shows
        })
        .catch(() => undefined)
        .finally(() => this.inFlight.delete(layer.id));
    }
    return existing ? result(existing) : null;
  }

  /**
   * Like {@link get} but AWAITS the rasterization and caches it, so the next `get(...)` with the same key is
   * an immediate cache hit. The editor tolerates `get`'s 1-frame async delay (the rAF loop re-draws); the
   * EXPORT can't — each exported frame must be complete — so it calls `ensure` for every text/shape layer
   * before building the frame's draw list. Frames export sequentially, so no concurrent write to the pool.
   */
  async ensure(layer: TimelineLayer, t: number, width: number, height: number, boxMode = false): Promise<SceneRaster | null> {
    if (this.disposed || width <= 0 || height <= 0) return null;
    const bucket = boxMode ? this.bucketFor(layer, t) : 0;
    const key = this.keyFor(layer, t, width, height, bucket, boxMode);
    const existing = this.cache.get(layer.id);
    if (existing && existing.key === key) return result(existing);
    const raster = await this.rasterize(layer, t, width, height, bucket, boxMode);
    if (this.disposed) return null;
    const entry: RasterEntry = { key, canvas: raster?.canvas ?? null, boxHalfW: raster?.boxHalfW, boxHalfH: raster?.boxHalfH };
    this.cache.set(layer.id, entry);
    this.versions.set(layer.id, (this.versions.get(layer.id) ?? 0) + 1);
    return result(entry);
  }

  /** Content version of the layer's currently-cached raster, for the compositor's skip-upload check. */
  versionOf(layerId: string): number | undefined {
    return this.versions.get(layerId);
  }

  private async rasterize(
    layer: TimelineLayer,
    t: number,
    width: number,
    height: number,
    bucket: number,
    boxMode: boolean,
  ): Promise<SceneRaster | null> {
    if (!boxMode) {
      // Comp mode (blur/glow path): comp-sized canvas, content-centered, transform-independent (4.1b).
      // The composite quad uses the comp box, so no box half-extents are returned.
      const { canvas, ctx } = this.poolCanvas(layer.id, width, height);
      const box =
        layer.type === "text"
          ? await drawTextLayer(ctx, layer, t, width, height, "content")
          : drawShapeLayer(ctx, layer, t, width, height, "content");
      if (box.boxW <= 0 || box.boxH <= 0) return null; // empty (e.g. no visible text yet)
      return { canvas };
    }

    // Box mode (resolution-aware): measure the tight element box, size the canvas to
    // (box+margin)*rasterScale, then draw at that scale so magnified text stays crisp. The composite
    // quad's element box = the padded canvas back in comp px (the content is centered within it).
    const content = measureOverlayBox(this.measureCtx(), layer, t, width, height);
    if (content.boxW <= 0 || content.boxH <= 0) return null;
    const m = overlayOverhangMargin(layer, t); // headroom so shadow/stroke/border don't clip the tight box
    const paddedW = content.boxW + 2 * m;
    const paddedH = content.boxH + 2 * m;
    // Cap so the canvas can't exceed MAX_RASTER_DIM (VRAM + GPU max-texture bound); extreme zoom is then
    // sharper-but-bounded. rasterScale can dip below 1 only for a box already larger than the cap.
    const rasterScale = Math.min(Math.pow(2, bucket), MAX_RASTER_DIM / paddedW, MAX_RASTER_DIM / paddedH);
    const cw = Math.max(1, Math.ceil(paddedW * rasterScale));
    const ch = Math.max(1, Math.ceil(paddedH * rasterScale));
    const { canvas, ctx } = this.poolCanvas(layer.id, cw, ch);
    const drawn =
      layer.type === "text"
        ? await drawTextLayer(ctx, layer, t, width, height, "box", rasterScale)
        : drawShapeLayer(ctx, layer, t, width, height, "box", rasterScale);
    if (drawn.boxW <= 0 || drawn.boxH <= 0) return null;
    return { canvas, boxHalfW: cw / (2 * rasterScale), boxHalfH: ch / (2 * rasterScale) };
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.pool.clear();
    this.versions.clear();
    this.inFlight.clear();
    if (this.fontsTimer) clearTimeout(this.fontsTimer);
    if (typeof document !== "undefined" && (document as Document).fonts) {
      (document as Document).fonts.removeEventListener?.("loadingdone", this.onFonts);
    }
  }
}
