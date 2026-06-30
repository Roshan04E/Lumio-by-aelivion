/**
 * Single GPU compositor preview surface (Method 3, Phases 1-4).
 *
 * Renders ONE `<canvas>` that the shared `SceneCompositor` composites every visual layer into — the
 * GPU replacement for laying each per-clip graded canvas out as a separate DOM sibling. MEDIA layers'
 * grading is unchanged: the caller mounts their `WebglMediaLayer`s (hidden) so they grade into
 * `gradedRef`; this component reads those graded canvases as textures (object-fit + clip mask +
 * transform + blend + blur/glow in the GPU pass). TEXT/SHAPE layers (Phase 4) are rasterized via the
 * export's `drawTextLayer`/`drawShapeLayer` (cached in `SceneTextRasterizer`) and composited as
 * `fit:"fill"` identity layers, so they interleave with media by z-order and pick up GPU blend +
 * blur/glow for free. Only selection/motion/mask **handles** stay DOM (the caller renders them).
 *
 * Opacity + transform are baked into each source (graded canvas for media, mode-"full" raster for
 * text/shape), so the compositor draws media at full opacity and text/shape with an identity transform.
 *
 * This whole surface only mounts when the `compositor=scene` flag is on AND the comp is scene-eligible
 * (see `VideoPreview`); otherwise the shipped DOM path renders unchanged.
 */

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import {
  SceneCompositor,
  MediaWebGLRenderer,
  SceneMaskMatteCache,
  SceneTextRasterizer,
  buildSceneDraws,
  type SceneFrameSpec,
  type TimelineLayer,
  type ScenePreviewTransition,
} from "@reelforge/shared";
import { isPreviewSuspendedForExport } from "../export/export-preview-suspend";

export type { ScenePreviewTransition } from "@reelforge/shared";

// After any change (scrub/seek/mount) keep compositing for this long so async work — a clip's graded
// frame, a text raster — lands on screen. While PLAYING we composite every frame regardless.
const SCENE_SETTLE_MS = 600;

export interface ScenePreviewCanvasProps {
  /** ALL scene-eligible visual layers (media + text/shape) in back-to-front (z) order. Includes the two
   *  clips of an active transition, so the mix can be placed at the incoming clip's z-slot. */
  layers: TimelineLayer[];
  width: number;
  height: number;
  backgroundColor: string;
  currentTime: number;
  isPlaying: boolean;
  /** Live map of each layer's graded canvas, populated by the hidden WebglMediaLayers. */
  gradedRef: React.MutableRefObject<Record<string, HTMLCanvasElement | null>>;
  /** Called if the GPU compositor can't init/draw — the caller falls back to the DOM path. */
  onFailure?: () => void;
  /**
   * Populated with this canvas's `requestDraw` so the caller can re-arm a recomposite imperatively (no
   * React re-render) when a MEDIA layer re-grades while paused — the analog of the text rasterizer's
   * `onReady`. Without it a paused re-grade only lands via the `layers`-change settle window (a timing
   * heuristic), which can leave the viewer showing a stale frame after an edit.
   */
  redrawRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * Playback render-resolution scale (1 = Full, 0.5 = Half, 0.25 = Quarter). The GPU BACKING renders at
   * `comp × renderScale` while the canvas CSS display size stays logical comp (the browser upscales) — so
   * every GPU pass rasterizes `renderScale²` the fragments. Logical comp (text layout, transforms, masks)
   * is unchanged; only the element-box quad half-extents scale with it. Caller passes 1 when paused.
   */
  renderScale?: number;
  /** Active junction transitions at `currentTime` — the scene pass mixes them in (Phase 4.2). */
  transitions?: ScenePreviewTransition[];
  /**
   * Region-blur clone → base layer id. A region-mask blur expands a media layer into [base, blurred-region
   * clone]; the clone's decoded+graded media source is IDENTICAL to its base (blur is a GPU pass here, not
   * baked into the grade), so the caller does NOT mount the clone's own `WebglMediaLayer` — this maps the
   * clone's id to the base whose graded canvas it reads. Saves a `<video>` decoder + GL context per clone
   * (the "too many WebGL contexts" eviction) and keeps the clone frame-synced to the base.
   */
  mediaSourceAlias?: Map<string, string>;
}

export function ScenePreviewCanvas({
  layers,
  width,
  height,
  backgroundColor,
  currentTime,
  isPlaying,
  gradedRef,
  onFailure,
  redrawRef,
  renderScale = 1,
  transitions = [],
  mediaSourceAlias,
}: ScenePreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<SceneCompositor | null>(null);
  const matteCacheRef = useRef<SceneMaskMatteCache | null>(null);
  const rasterizerRef = useRef<SceneTextRasterizer | null>(null);
  // Per-text/shape-layer color-grade renderers (Phase 4.1c). A graded overlay's UNGRADED raster stays
  // cached (transform/grade-independent — the 4.1b win); the grade is applied as a post-pass through the
  // SAME `MediaWebGLRenderer` the media path + export overlay-grade use, so the result becomes the scene
  // source. Lazily created per layer that actually has a non-identity pipeline; pruned when the layer
  // leaves the draw set so we don't leak WebGL contexts.
  const gradeRenderersRef = useRef<Map<string, { renderer: MediaWebGLRenderer; pipelineKey: string }>>(new Map());
  const failedRef = useRef(false);
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;
  const fail = (where: string, error: unknown) => {
    if (failedRef.current) return;
    failedRef.current = true;
    console.error(`ScenePreviewCanvas: GPU compositor ${where} failed — falling back to DOM path`, error);
    onFailureRef.current?.();
  };
  // Keep the latest inputs in a ref so the rAF playback loop reads live values without re-subscribing.
  const inputsRef = useRef({ layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, mediaSourceAlias });
  inputsRef.current = { layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, mediaSourceAlias };
  // Event-driven redraw: composite while playing, or for a settle window after any input change /
  // async raster arrival. Idle (paused, settled) costs ~one cheap timestamp check per frame, not a
  // full recomposite — this is what keeps the timeline + viewer responsive in scene mode.
  const activeUntilRef = useRef(0);
  const requestDraw = () => {
    activeUntilRef.current = (typeof performance !== "undefined" ? performance.now() : Date.now()) + SCENE_SETTLE_MS;
  };
  // Hand `requestDraw` to the caller (imperative, no re-render) so a media re-grade can re-arm a
  // recomposite — `requestDraw` only touches a ref, so assigning it every render is cheap and safe.
  if (redrawRef) redrawRef.current = requestDraw;
  useEffect(requestDraw, [layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions]);

  // Create / dispose the compositor with the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      compositorRef.current = new SceneCompositor(canvas, width, height);
      matteCacheRef.current = new SceneMaskMatteCache(width, height);
      // A late async raster (text/font) re-arms the settle window so it lands on screen even when idle.
      rasterizerRef.current = new SceneTextRasterizer(requestDraw);
    } catch (error) {
      compositorRef.current = null;
      fail("init", error);
    }
    return () => {
      compositorRef.current?.dispose();
      compositorRef.current = null;
      matteCacheRef.current?.dispose();
      matteCacheRef.current = null;
      rasterizerRef.current?.dispose();
      rasterizerRef.current = null;
      for (const { renderer } of gradeRenderersRef.current.values()) renderer.dispose();
      gradeRenderersRef.current.clear();
    };
    // Re-create only when the comp dimensions change (the compositor sizes its FBOs to them).
  }, [width, height]);

  // The latest draw closure, kept in a ref so the persistent rAF loop always runs current logic
  // without re-subscribing. Reads live values from `inputsRef` / `gradedRef` (both stable refs).
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const compositor = compositorRef.current;
    if (!compositor || failedRef.current) return;
    const { layers: ls, width: w, height: h, backgroundColor: bg, currentTime: t, renderScale: rScale, transitions: tPairs, mediaSourceAlias: alias } = inputsRef.current;
    // Logical comp (w/h) drives text layout + the matte; the GPU BACKING renders at comp*renderScale.
    // Element-box half-extents (logical comp px) scale with it; media/mask are scale-invariant/normalized.
    const renderW = Math.max(1, Math.round(w * rScale));
    const renderH = Math.max(1, Math.round(h * rScale));
    // The draw-list build is shared with the local export (`SceneFrameCompositor`) — see build-scene-draws.
    // The only editor-specific input is the media graded canvas, read here from the hidden WebglMediaLayers.
    const draws = buildSceneDraws({
      layers: ls,
      width: w,
      height: h,
      currentTime: t,
      renderScale: rScale,
      transitions: tPairs,
      rasterizer: rasterizerRef.current,
      matteCache: matteCacheRef.current,
      gradeRenderers: gradeRenderersRef.current,
      // A region-blur clone reads its base layer's graded canvas (no own decoder/context) — see mediaSourceAlias.
      getMediaGraded: (id) => gradedRef.current[id] ?? (alias ? gradedRef.current[alias.get(id) ?? ""] ?? null : null),
      createCanvas: () => document.createElement("canvas"),
    });

    const spec: SceneFrameSpec = { width: renderW, height: renderH, backgroundColor: bg, layers: draws };
    try {
      compositor.renderFrame(spec);
    } catch (error) {
      fail("render", error);
    }
  };

  // rAF loop that only COMPOSITES while playing or inside a settle window (after a change / async raster
  // arrival). When idle it's a single timestamp check + reschedule — no GPU work, no texture uploads —
  // so the scene compositor doesn't steal main-thread/GPU time from the timeline + viewer when paused.
  useEffect(() => {
    let raf = 0;
    let wasSuspended = false;
    const loop = () => {
      // During a main-thread export this compositor must NOT touch its WebGL context: the export's own
      // contexts can evict ours, and rendering through the dead context floods the console. Skip drawing
      // while suspended; on release re-arm a settle window so we repaint the current frame.
      if (isPreviewSuspendedForExport()) {
        wasSuspended = true;
      } else {
        if (wasSuspended) {
          wasSuspended = false;
          requestDraw();
        }
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (inputsRef.current.isPlaying || now < activeUntilRef.current) drawRef.current();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Non-interactive: selection boxes / motion-path handles are separate DOM overlays that must stay
  // clickable above this canvas.
  const style: CSSProperties = { position: "absolute", left: 0, top: 0, width, height, pointerEvents: "none" };
  return <canvas ref={canvasRef} className="preview-scene-canvas" style={style} aria-hidden="true" />;
}
