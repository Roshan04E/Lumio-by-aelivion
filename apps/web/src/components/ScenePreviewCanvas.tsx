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

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  SceneCompositor,
  SCENE_COMPOSITOR_CONTEXT_LOST,
  MEDIA_RENDERER_CONTEXT_LOST,
  MediaWebGLRenderer,
  RenderTarget,
  getTexImageSourceProducerInfo,
  SceneMaskMatteCache,
  SceneTextRasterizer,
  buildSceneDraws,
  type ColorPipeline,
  type SceneFrameSpec,
  type SceneTextureSource,
  type TimelineLayer,
  type ScenePreviewTransition,
} from "@lumio-by-aelivion/shared";
import { isPreviewSuspendedForExport } from "../export/export-preview-suspend";

export type { ScenePreviewTransition } from "@lumio-by-aelivion/shared";

// After any change (scrub/seek/mount) keep compositing for this long so async work — a clip's graded
// frame, a text raster — lands on screen. While PLAYING we composite every frame regardless.
const SCENE_SETTLE_MS = 600;

// Bounded GPU recovery. On a WebGL context loss the preview used to latch PERMANENTLY to the DOM path — which
// is NOT pixel-identical to the scene compositor, so a transient GPU eviction meant a lasting fidelity + quality
// regression. Instead we rebuild the compositor on a fresh context up to MAX_SCENE_REBUILDS times (backoff
// below), keeping the EXACT GPU scene; only after the budget is exhausted do we degrade to DOM, once, quietly.
// The context governor (getGlGovernorEnabled) keeps large timelines under the browser cap so a loss is rare in
// the first place; this is the safety net for when one still happens.
const MAX_SCENE_REBUILDS = 3;
const RECOVERY_BACKOFF_MS = [150, 300, 600];
// A sustained run of clean frames after a rebuild resets the attempt budget, so a later unrelated loss gets a
// fresh set of retries instead of immediately falling to DOM.
const HEALTHY_FRAMES_TO_RESET = 120;

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
  /** Called after the scene compositor successfully renders a frame. Used by live preview proxy coverage. */
  onFrameRendered?: ((timeSeconds: number) => void) | undefined;
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
  onFrameRendered,
  mediaSourceAlias,
}: ScenePreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<SceneCompositor | null>(null);
  const matteCacheRef = useRef<SceneMaskMatteCache | null>(null);
  const rasterizerRef = useRef<SceneTextRasterizer | null>(null);
  const rafRef = useRef<number>(0);
  const disposedRef = useRef(false);
  const contextLostRef = useRef(false);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const sharedGradeRenderersRef = useRef<Map<string, { renderer: MediaWebGLRenderer; target: RenderTarget; pipelineKey: string }>>(new Map());
  // Per-text/shape-layer color-grade renderers (Phase 4.1c). A graded overlay's UNGRADED raster stays
  // cached (transform/grade-independent — the 4.1b win); the grade is applied as a post-pass through the
  // SAME `MediaWebGLRenderer` the media path + export overlay-grade use, so the result becomes the scene
  // source. Lazily created per layer that actually has a non-identity pipeline; pruned when the layer
  // leaves the draw set so we don't leak WebGL contexts.
  const gradeRenderersRef = useRef<Map<string, { renderer: MediaWebGLRenderer; pipelineKey: string }>>(new Map());
  const failedRef = useRef(false);
  // Bounded-recovery bookkeeping (see MAX_SCENE_REBUILDS above).
  const rebuildAttemptsRef = useRef(0);
  const goodFramesRef = useRef(0);
  const recoveryTimerRef = useRef<number | null>(null);
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;
  const stopLoop = () => {
    if (!rafRef.current) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };
  const disposeResources = () => {
    try {
      compositorRef.current?.dispose();
    } catch {
      /* ignore teardown after context loss */
    }
    compositorRef.current = null;
    try {
      matteCacheRef.current?.dispose();
    } catch {
      /* ignore */
    }
    matteCacheRef.current = null;
    try {
      rasterizerRef.current?.dispose();
    } catch {
      /* ignore */
    }
    rasterizerRef.current = null;
    for (const { renderer } of gradeRenderersRef.current.values()) {
      try {
        renderer.dispose();
      } catch {
        /* ignore */
      }
    }
    gradeRenderersRef.current.clear();
    for (const { renderer, target } of sharedGradeRenderersRef.current.values()) {
      try {
        renderer.dispose();
      } catch {
        /* ignore */
      }
      try {
        target.dispose();
      } catch {
        /* ignore */
      }
    }
    sharedGradeRenderersRef.current.clear();
  };
  const isContextLostError = (error: unknown) => error instanceof Error && (error.message === SCENE_COMPOSITOR_CONTEXT_LOST || error.message === MEDIA_RENDERER_CONTEXT_LOST);
  /**
   * A recoverable GPU context loss happened. Schedule a bounded rebuild of the compositor on a fresh context
   * (backoff) rather than degrading to the DOM path. Only once the retry budget is exhausted do we hand off to
   * DOM — once, quietly. Idempotent while a rebuild is already pending; logs once per loss, not per frame.
   */
  const scheduleSceneRecovery = () => {
    if (disposedRef.current || recoveryTimerRef.current != null) return;
    if (rebuildAttemptsRef.current >= MAX_SCENE_REBUILDS) {
      console.warn("ScenePreviewCanvas: GPU compositor context lost after retries; falling back to DOM path");
      onFailureRef.current?.();
      return;
    }
    const attempt = rebuildAttemptsRef.current;
    rebuildAttemptsRef.current = attempt + 1;
    goodFramesRef.current = 0;
    const delay = RECOVERY_BACKOFF_MS[Math.min(attempt, RECOVERY_BACKOFF_MS.length - 1)] ?? 600;
    console.warn(`ScenePreviewCanvas: GPU compositor context lost; controlled rebuild ${attempt + 1}/${MAX_SCENE_REBUILDS} in ${delay}ms`);
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      if (disposedRef.current) return;
      // Bumping recoveryTick re-runs the create effect (which clears failed/contextLost flags and rebuilds the
      // compositor on a fresh context) and the rAF-loop effect.
      setRecoveryTick((tick) => tick + 1);
    }, delay);
  };
  const fail = (where: string, error: unknown) => {
    if (failedRef.current) return;
    failedRef.current = true;
    stopLoop();
    disposeResources();
    if (isContextLostError(error)) {
      contextLostRef.current = true;
      // Recoverable — rebuild the exact GPU scene instead of latching to the DOM path.
      scheduleSceneRecovery();
      return;
    }
    console.error(`ScenePreviewCanvas: GPU compositor ${where} failed - falling back to DOM path`, error);
    onFailureRef.current?.();
  };
  // Keep the latest inputs in a ref so the rAF playback loop reads live values without re-subscribing.
  const inputsRef = useRef({ layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, onFrameRendered, mediaSourceAlias });
  inputsRef.current = { layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, onFrameRendered, mediaSourceAlias };
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

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      stopLoop();
      disposeResources();
      if (recoveryTimerRef.current != null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      if (redrawRef?.current === requestDraw) redrawRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Create / dispose the compositor with the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      failedRef.current = false;
      contextLostRef.current = false;
      compositorRef.current = new SceneCompositor(canvas, width, height);
      matteCacheRef.current = new SceneMaskMatteCache(width, height);
      // A late async raster (text/font) re-arms the settle window so it lands on screen even when idle.
      rasterizerRef.current = new SceneTextRasterizer(requestDraw);
      // Repaint the current frame after a (re)build — including a recovery rebuild (recoveryTick), so a paused
      // preview immediately shows the restored GPU scene instead of a blank canvas until the next input change.
      requestDraw();
    } catch (error) {
      compositorRef.current = null;
      fail("init", error);
    }
    return () => {
      disposeResources();
    };
    // Re-create only when the comp dimensions change (the compositor sizes its FBOs to them).
  }, [width, height, recoveryTick]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const handleLost = (event: Event) => {
      event.preventDefault();
      if (contextLostRef.current) return;
      contextLostRef.current = true;
      failedRef.current = true;
      stopLoop();
      disposeResources();
      // Rebuild the GPU compositor (bounded) instead of a permanent DOM fallback — keeps the exact scene.
      scheduleSceneRecovery();
    };
    const handleRestored = () => {
      if (disposedRef.current) return;
      // The browser restored the context on its own — a clean recovery, so give it a fresh retry budget.
      rebuildAttemptsRef.current = 0;
      goodFramesRef.current = 0;
      contextLostRef.current = false;
      failedRef.current = false;
      setRecoveryTick((tick) => tick + 1);
      requestDraw();
    };
    canvas.addEventListener("webglcontextlost", handleLost);
    canvas.addEventListener("webglcontextrestored", handleRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", handleLost);
      canvas.removeEventListener("webglcontextrestored", handleRestored);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The latest draw closure, kept in a ref so the persistent rAF loop always runs current logic
  // without re-subscribing. Reads live values from `inputsRef` / `gradedRef` (both stable refs).
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const compositor = compositorRef.current;
    if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return;
    const { layers: ls, width: w, height: h, backgroundColor: bg, currentTime: t, isPlaying: playing, renderScale: rScale, transitions: tPairs, onFrameRendered: frameRendered, mediaSourceAlias: alias } = inputsRef.current;
    // Logical comp (w/h) drives text layout + the matte; the GPU BACKING renders at comp*renderScale.
    // Element-box half-extents (logical comp px) scale with it; media/mask are scale-invariant/normalized.
    const renderW = Math.max(1, Math.round(w * rScale));
    const renderH = Math.max(1, Math.round(h * rScale));
    const isLiveMediaCanvas = (canvas: HTMLCanvasElement | null | undefined): canvas is HTMLCanvasElement => {
      if (!canvas) return false;
      const producer = getTexImageSourceProducerInfo(canvas);
      return !producer || (!producer.disposed && !producer.contextLost);
    };
    const getMediaGradedSource = (id: string): HTMLCanvasElement | null => {
      let resolvedId = id;
      const seen = new Set<string>();
      while (alias?.has(resolvedId) && !seen.has(resolvedId)) {
        seen.add(resolvedId);
        resolvedId = alias.get(resolvedId)!;
      }
      const explicit = gradedRef.current[resolvedId];
      if (isLiveMediaCanvas(explicit)) return explicit;

      // User-duplicated region/media layers can carry `_copy_...` ids without an explicit render-effect alias.
      // Prefer the nearest live base canvas over a stale duplicate canvas.
      let copyIdx = id.lastIndexOf("_copy_");
      while (copyIdx > 0) {
        const baseId = id.slice(0, copyIdx);
        const base = gradedRef.current[baseId];
        if (isLiveMediaCanvas(base)) return base;
        copyIdx = baseId.lastIndexOf("_copy_");
      }
      const own = gradedRef.current[id];
      return isLiveMediaCanvas(own) ? own : null;
    };
    const gradeOverlay = (layerId: string, srcCanvas: HTMLCanvasElement | OffscreenCanvas, pipeline: ColorPipeline): SceneTextureSource | null => {
      if (compositor.isContextLost()) throw new Error(SCENE_COMPOSITOR_CONTEXT_LOST);
      const gl = compositor.sharedGl;
      const targetW = Math.max(1, srcCanvas.width);
      const targetH = Math.max(1, srcCanvas.height);
      let entry = sharedGradeRenderersRef.current.get(layerId);
      if (!entry) {
        entry = {
          renderer: new MediaWebGLRenderer({ sharedGl: gl }),
          target: new RenderTarget(gl, targetW, targetH),
          pipelineKey: "",
        };
        sharedGradeRenderersRef.current.set(layerId, entry);
      }
      entry.target.resize(targetW, targetH);
      const pipelineKey = JSON.stringify(pipeline);
      if (entry.pipelineKey !== pipelineKey) {
        entry.renderer.setPipeline(pipeline);
        entry.pipelineKey = pipelineKey;
      }
      entry.renderer.draw({
        source: srcCanvas,
        sourceWidth: targetW,
        sourceHeight: targetH,
        matte: null,
        pipeline,
        amount: 1,
        opacity: 1,
        mediaEffects: null,
        target: entry.target,
      });
      return { texture: entry.target.tex, width: targetW, height: targetH };
    };
    // The draw-list build is shared with the local export (`SceneFrameCompositor`) — see build-scene-draws.
    // The only editor-specific input is the media graded canvas, read here from the hidden WebglMediaLayers.
    let draws: SceneFrameSpec["layers"];
    try {
      draws = buildSceneDraws({
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
        getMediaGraded: getMediaGradedSource,
      gradeOverlay,
      createCanvas: () => document.createElement("canvas"),
      });
    } catch (error) {
      fail("build draw list", error);
      return;
    }

    const liveLayerIds = new Set(ls.map((layer) => layer.id));
    for (const [id, { renderer, target }] of sharedGradeRenderersRef.current) {
      if (liveLayerIds.has(id)) continue;
      renderer.dispose();
      target.dispose();
      sharedGradeRenderersRef.current.delete(id);
    }

    const spec: SceneFrameSpec = { width: renderW, height: renderH, backgroundColor: bg, layers: draws, debugFrameTime: t };
    try {
      compositor.renderFrame(spec);
      if (playing) {
        frameRendered?.(t);
      }
    } catch (error) {
      fail("render", error);
    }
  };

  // rAF loop that only COMPOSITES while playing or inside a settle window (after a change / async raster
  // arrival). When idle it's a single timestamp check + reschedule — no GPU work, no texture uploads —
  // so the scene compositor doesn't steal main-thread/GPU time from the timeline + viewer when paused.
  useEffect(() => {
    let cancelled = false;
    let wasSuspended = false;
    const loop = () => {
      const compositor = compositorRef.current;
      if (cancelled || disposedRef.current || failedRef.current || contextLostRef.current || !compositor || compositor.isContextLost()) {
        if (compositor?.isContextLost() && !failedRef.current) {
          contextLostRef.current = true;
          failedRef.current = true;
          disposeResources();
          scheduleSceneRecovery();
        }
        rafRef.current = 0;
        return;
      }
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
        if (inputsRef.current.isPlaying || now < activeUntilRef.current) {
          drawRef.current();
          // A sustained run of clean frames after a rebuild restores the full retry budget.
          if (rebuildAttemptsRef.current > 0 && !failedRef.current && !contextLostRef.current) {
            goodFramesRef.current += 1;
            if (goodFramesRef.current >= HEALTHY_FRAMES_TO_RESET) {
              rebuildAttemptsRef.current = 0;
              goodFramesRef.current = 0;
            }
          }
        }
      }
      const nextCompositor = compositorRef.current;
      if (cancelled || disposedRef.current || contextLostRef.current || failedRef.current || !nextCompositor || nextCompositor.isContextLost()) {
        if (nextCompositor?.isContextLost() && !failedRef.current) {
          contextLostRef.current = true;
          failedRef.current = true;
          disposeResources();
          scheduleSceneRecovery();
        }
        rafRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    stopLoop();
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      stopLoop();
    };
  }, [recoveryTick]);

  // Non-interactive: selection boxes / motion-path handles are separate DOM overlays that must stay
  // clickable above this canvas.
  const style: CSSProperties = { position: "absolute", left: 0, top: 0, width, height, pointerEvents: "none" };
  return <canvas ref={canvasRef} className="preview-scene-canvas" style={style} aria-hidden="true" />;
}
