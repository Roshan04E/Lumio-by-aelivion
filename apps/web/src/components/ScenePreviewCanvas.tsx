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
  GL_CONTEXT_LOST,
  MediaWebGLRenderer,
  RenderTarget,
  getCompositionFilterEffects,
  getTexImageSourceProducerInfo,
  getTransition,
  SceneMaskMatteCache,
  SceneTextRasterizer,
  buildSceneDraws,
  colorPipelineCacheKey,
  type ColorPipeline,
  type NestedGroupSpec,
  type SceneFrameSpec,
  type SceneTextureSource,
  type TimelineLayer,
  type ScenePreviewTransition,
} from "@kimera-by-aelivion/shared";
import { isPreviewSuspendedForExport } from "../export/export-preview-suspend";
import { recordPlaybackFrame } from "../editor/performance/frame-stats";
import { getRegionPassesEnabled } from "../color/render-engine";
import type { ScenePreviewMediaSource } from "./scene-media-source";

export type { ScenePreviewTransition } from "@kimera-by-aelivion/shared";

/** Soak telemetry (__rf* convention) for the single-ctx preview: `grades` = in-context media grades that
 *  actually ran, `skips` = frames a media layer's cached RenderTarget was reused (unchanged frame + grade).
 *  A nonzero `grades` proves the GPU-first path is engaged (window.__rfSingleCtxPreview). */
function recordSingleCtx(kind: "grades" | "skips"): void {
  if (typeof window === "undefined") return;
  const w = window as { __rfSingleCtxPreview?: { grades: number; skips: number } };
  const s = (w.__rfSingleCtxPreview ??= { grades: 0, skips: 0 });
  s[kind] += 1;
}

/**
 * Viewer-capture handle (todo.md Phase 6B P1a — "the proxy IS the viewer"). Lets the background proxy
 * generator render arbitrary timeline times through THIS preview's own SceneCompositor instance — same
 * texture caches, text rasterizer, matte cache, draw builder, and flags as the visible frame — WITHOUT
 * presenting, so the on-screen canvas keeps its last frame. The caller supplies its own media sources
 * (pooled `<video>` decode + shared-context grade); everything else is the live viewer.
 */
export interface SceneViewerCaptureHandle {
  /** Compositor's shared GL context for caller-owned grade renderers (null when lost/unavailable). */
  getSharedGl(): WebGL2RenderingContext | null;
  /** Rasterize text/shape layers for `timeSeconds` (async; cached — cheap after the first frame). */
  ensureTextRasters(layers: TimelineLayer[], timeSeconds: number): Promise<void>;
  /**
   * Build the frame's draw list at `timeSeconds` with caller-provided media and composite it offscreen.
   * Returns top-origin RGBA pixels at the current backing size, or null when the compositor is unavailable.
   */
  renderOffscreen(input: {
    layers: TimelineLayer[];
    timeSeconds: number;
    transitions: ScenePreviewTransition[];
    getMediaGraded: (id: string) => HTMLCanvasElement | SceneTextureSource | null;
    buffer?: Uint8Array | undefined;
  }): { pixels: Uint8Array; width: number; height: number } | null;
  /**
   * Downsample the RETAINED composite (last presented frame) into a small top-origin RGBA thumbnail
   * for the color scopes — no re-composite, no dependence on the on-screen canvas. Null when the
   * compositor is unavailable this frame (caller falls back to a DOM-element sample).
   */
  readCompositeThumbnail(
    targetW: number,
    targetH: number,
    buffer?: Uint8Array
  ): { pixels: Uint8Array; width: number; height: number } | null;
  /** Dispose the capture-scoped text-grade renderers (call when a capture run finishes). */
  releaseCaptureResources(): void;
}

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
  /**
   * Single-context GPU-first preview (Phase 5, `kimera.singleCtxPreview`). When true, media layers do NOT
   * grade into `gradedRef`; instead each publishes a raw frame-source descriptor into `mediaSourcesRef`,
   * and THIS component grades the frame in-context through a shared-context `MediaWebGLRenderer` +
   * `RenderTarget` on the SceneCompositor's own WebGL2 context (one upload/layer/frame, zero per-clip GL
   * contexts). Mirrors the single-context EXPORT path. Off (default) = the shipped per-clip-canvas path.
   */
  singleCtxMedia?: boolean | undefined;
  /** Single-ctx: live map of each media layer's raw frame-source descriptor (see `singleCtxMedia`). */
  mediaSourcesRef?: React.MutableRefObject<Record<string, ScenePreviewMediaSource | null>> | undefined;
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
  /** Compound-clip group specs from `expandNestedCompositions` (NESTING.md Phase C) — `layers` above is
   *  already the FULLY EXPANDED list (nested children present as ordinary layers); this is consulted only
   *  to fold them back into a `SceneGroupDraw` per compound-clip instance. Undefined/empty = no nesting. */
  nestedGroups?: ReadonlyMap<string, NestedGroupSpec> | undefined;
  /** Populated with the viewer-capture handle (background proxy generation renders through THIS preview). */
  captureRef?: React.MutableRefObject<SceneViewerCaptureHandle | null> | undefined;
  /**
   * Every shader-transition id the composition uses (not just the active ones) — pre-warmed
   * (compiled + cached) during idle so the first frame of a cut never pays a compile stall.
   */
  prewarmTransitionIds?: readonly string[] | undefined;
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
  nestedGroups,
  captureRef,
  prewarmTransitionIds,
  singleCtxMedia = false,
  mediaSourcesRef,
}: ScenePreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<SceneCompositor | null>(null);
  const matteCacheRef = useRef<SceneMaskMatteCache | null>(null);
  // Per-nested-composition matte caches (NESTING.md Phase C), pooled across frames — see the
  // `nestMatteCaches` doc on `BuildSceneDrawsInputs`. Lives independently of `matteCacheRef` (which is
  // fixed to the PARENT comp's size); disposed alongside it on unmount/rebuild.
  const nestMatteCachesRef = useRef<Map<string, SceneMaskMatteCache>>(new Map());
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
  // Single-ctx preview (Phase 5): per-MEDIA-layer shared-context grade renderer + output RTT, keyed by the
  // RESOLVED source id (a blur clone aliases to its base → base graded once, clone samples the same target).
  // `lastKey` folds the layer's frame version + grade keys so an unchanged media frame skips the re-grade +
  // upload entirely (the static-photo win). Lives on the compositor's context; disposed on rebuild/unmount.
  const sharedMediaRenderersRef = useRef<
    Map<string, { renderer: MediaWebGLRenderer; target: RenderTarget; pipelineKey: string; lastKey: string; lastW: number; lastH: number }>
  >(new Map());
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
    for (const cache of nestMatteCachesRef.current.values()) {
      try {
        cache.dispose();
      } catch {
        /* ignore */
      }
    }
    nestMatteCachesRef.current.clear();
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
    for (const { renderer, target } of sharedMediaRenderersRef.current.values()) {
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
    sharedMediaRenderersRef.current.clear();
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
  const isContextLostError = (error: unknown) =>
    error instanceof Error &&
    (error.message === SCENE_COMPOSITOR_CONTEXT_LOST || error.message === MEDIA_RENDERER_CONTEXT_LOST || error.message === GL_CONTEXT_LOST);
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
  const inputsRef = useRef({ layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, onFrameRendered, mediaSourceAlias, nestedGroups });
  inputsRef.current = { layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, onFrameRendered, mediaSourceAlias, nestedGroups };
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
  useEffect(requestDraw, [layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, nestedGroups]);

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

  // Shader pre-warm (P0 — first-frame-of-cut compile stall): compile every transition program the
  // composition uses during IDLE time, so entering a transition during playback never pays a
  // 10–50ms main-thread shader compile. Idempotent per program; re-runs after a context recovery.
  useEffect(() => {
    if (!prewarmTransitionIds?.length) return undefined;
    const idle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 200);
    const cancel =
      typeof cancelIdleCallback === "function" ? cancelIdleCallback : window.clearTimeout;
    const handle = idle(() => {
      const compositor = compositorRef.current;
      if (!compositor || contextLostRef.current) return;
      const defs = prewarmTransitionIds
        .map((id) => getTransition(id))
        .filter((def): def is NonNullable<typeof def> => def != null);
      compositor.prewarmTransitions(defs);
    });
    return () => cancel(handle as never);
  }, [prewarmTransitionIds, recoveryTick]);

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
    // recoveryTick: the canvas element is keyed on it (remounted per rebuild), so the listeners
    // must re-attach to the NEW element — with [] they'd keep watching the discarded one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryTick]);

  // Text/shape overlay grade through a pooled shared-context MediaWebGLRenderer. `keyPrefix` isolates the
  // viewer-capture path's pool entries ("capture:") from the live frame's — the two grade the same layer at
  // DIFFERENT times, and sharing one entry would rebake the LUT on every alternation.
  const makeGradeOverlayRef = useRef((compositor: SceneCompositor, keyPrefix: string) => {
    return (layerId: string, srcCanvas: HTMLCanvasElement | OffscreenCanvas, pipeline: ColorPipeline): SceneTextureSource | null => {
      if (compositor.isContextLost()) throw new Error(SCENE_COMPOSITOR_CONTEXT_LOST);
      const gl = compositor.sharedGl;
      const targetW = Math.max(1, srcCanvas.width);
      const targetH = Math.max(1, srcCanvas.height);
      const key = `${keyPrefix}${layerId}`;
      let entry = sharedGradeRenderersRef.current.get(key);
      if (!entry) {
        entry = {
          renderer: new MediaWebGLRenderer({ sharedGl: gl }),
          target: new RenderTarget(gl, targetW, targetH),
          pipelineKey: "",
        };
        sharedGradeRenderersRef.current.set(key, entry);
      }
      entry.target.resize(targetW, targetH);
      const pipelineKey = colorPipelineCacheKey(pipeline);
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
  });

  // The latest draw closure, kept in a ref so the persistent rAF loop always runs current logic
  // without re-subscribing. Reads live values from `inputsRef` / `gradedRef` (both stable refs).
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const compositor = compositorRef.current;
    if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return;
    const { layers: ls, width: w, height: h, backgroundColor: bg, currentTime: t, isPlaying: playing, renderScale: rScale, transitions: tPairs, onFrameRendered: frameRendered, mediaSourceAlias: alias, nestedGroups: nestGroups } = inputsRef.current;
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
      // Cycle-guard Set only when an alias chain actually starts here — the common no-alias
      // case allocated a Set per media layer per frame for a walk that was a no-op.
      if (alias?.has(resolvedId)) {
        const seen = new Set<string>();
        while (alias.has(resolvedId) && !seen.has(resolvedId)) {
          seen.add(resolvedId);
          resolvedId = alias.get(resolvedId)!;
        }
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

    // ── SINGLE-CTX PREVIEW (Phase 5): grade the media layer's RAW frame in-context ──────────────────
    // The layer publishes a frame-source descriptor (element / WC VideoFrame / settle / still) instead of
    // grading into a canvas. We upload it ONCE and grade through a shared-context MediaWebGLRenderer +
    // RenderTarget on THIS compositor's WebGL2 context, returning the RTT as a SceneTextureSource the
    // compositor samples directly (no cross-context upload) — the proven single-context export path.
    const liveMediaSourceIds = new Set<string>();
    const gradeMediaInContext = (resolvedId: string, source: ScenePreviewMediaSource): SceneTextureSource | null => {
      const snap = source.snapshot();
      let entry = sharedMediaRenderersRef.current.get(resolvedId);
      if (!snap.frame || snap.frame.width <= 0 || snap.frame.height <= 0) {
        // Transiently source-less: an element mid-seek drops readyState<2 for a few frames, a WC decode
        // is still in flight, a still is decoding. HOLD the last graded frame — the own-canvas path did
        // this implicitly (the graded canvas kept its last pixels through a seek); returning null here
        // dropped the layer from the draw list for a composite → a black flicker on every ruler click
        // (2026-07-07 soak report: 11 flickers / 19s of scrubbing).
        if (entry && entry.lastW > 0) {
          recordSingleCtx("skips");
          return { texture: entry.target.tex, width: entry.lastW, height: entry.lastH };
        }
        return null; // never had a frame — same as the old "no canvas yet" (poster covers it)
      }
      const gl = compositor.sharedGl;
      if (!entry) {
        entry = { renderer: new MediaWebGLRenderer({ sharedGl: gl }), target: new RenderTarget(gl, 1, 1), pipelineKey: "", lastKey: "", lastW: 0, lastH: 0 };
        sharedMediaRenderersRef.current.set(resolvedId, entry);
      }
      const w0 = snap.frame.width;
      const h0 = snap.frame.height;
      // Re-grade skip: unchanged frame version + grade keys → reuse the cached target (no upload/grade).
      // A matte is a live <video> whose pixels change with no versioned signal → never skip when present.
      const key = `${snap.frameVersion}|${snap.pipelineKey}|${snap.mediaEffectsKey}|${snap.amount}|${snap.bakedOpacity}|${snap.transitionKey}`;
      if (!snap.matte && entry.lastKey === key && entry.target.width === w0 && entry.target.height === h0) {
        recordSingleCtx("skips");
        return { texture: entry.target.tex, width: w0, height: h0 };
      }
      if (entry.pipelineKey !== snap.pipelineKey) {
        entry.renderer.setPipeline(snap.pipeline);
        entry.pipelineKey = snap.pipelineKey;
      }
      entry.renderer.draw({
        source: snap.frame.source,
        sourceWidth: w0,
        sourceHeight: h0,
        matte: snap.matte?.source ?? null,
        matteInvert: snap.matte?.invert ?? false,
        matteOpacity: snap.matte?.opacity ?? 1,
        pipeline: snap.pipeline,
        amount: snap.amount,
        opacity: snap.bakedOpacity,
        mediaEffects: snap.mediaEffects,
        transition: snap.transition,
        target: entry.target,
      });
      entry.lastKey = snap.matte ? "" : key; // matte present → force a re-grade next frame
      entry.lastW = w0;
      entry.lastH = h0;
      recordSingleCtx("grades");
      return { texture: entry.target.tex, width: w0, height: h0 };
    };
    const getMediaSingleCtx = (id: string): SceneTextureSource | null => {
      const sources = mediaSourcesRef?.current;
      if (!sources) return null;
      let resolvedId = id;
      if (alias?.has(resolvedId)) {
        const seen = new Set<string>();
        while (alias.has(resolvedId) && !seen.has(resolvedId)) {
          seen.add(resolvedId);
          resolvedId = alias.get(resolvedId)!;
        }
      }
      let src = sources[resolvedId];
      if (!src) {
        // `_copy_` duplicates without an explicit alias (mirrors the own-canvas fallback).
        let copyIdx = id.lastIndexOf("_copy_");
        while (!src && copyIdx > 0) {
          const baseId = id.slice(0, copyIdx);
          src = sources[baseId] ?? undefined;
          if (src) resolvedId = baseId;
          copyIdx = baseId.lastIndexOf("_copy_");
        }
      }
      if (!src) {
        src = sources[id] ?? undefined;
        if (src) resolvedId = id;
      }
      if (!src) return null;
      // Present (descriptor registered) → keep its renderer alive even if this frame's source isn't ready
      // yet, so a brief frame gap doesn't dispose+recreate the shared renderer/target.
      liveMediaSourceIds.add(resolvedId);
      return gradeMediaInContext(resolvedId, src);
    };

    const gradeOverlay = makeGradeOverlayRef.current(compositor, "");
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
      // Single-ctx: grade the layer's raw frame in-context (SceneTextureSource); otherwise read its graded
      // canvas. A region-blur clone aliases to its base in BOTH paths (no own decoder/context) — see mediaSourceAlias.
        getMediaGraded: singleCtxMedia ? getMediaSingleCtx : getMediaGradedSource,
      gradeOverlay,
      createCanvas: () => document.createElement("canvas"),
      regionPassModel: getRegionPassesEnabled(),
      nestedGroups: nestGroups,
      nestMatteCaches: nestMatteCachesRef.current,
      });
    } catch (error) {
      fail("build draw list", error);
      return;
    }

    const liveLayerIds = new Set(ls.map((layer) => layer.id));
    for (const [id, { renderer, target }] of sharedGradeRenderersRef.current) {
      // "capture:"-prefixed entries belong to the viewer-capture run (arbitrary times / layers) — its own
      // releaseCaptureResources() disposes them, not the live frame's prune.
      if (liveLayerIds.has(id) || id.startsWith("capture:")) continue;
      renderer.dispose();
      target.dispose();
      sharedGradeRenderersRef.current.delete(id);
    }
    // Single-ctx: dispose media-grade renderers whose source id wasn't consumed this frame (clip left the
    // window / its descriptor was withdrawn). `liveMediaSourceIds` is populated by gradeMediaInContext above.
    if (sharedMediaRenderersRef.current.size > 0) {
      for (const [id, { renderer, target }] of sharedMediaRenderersRef.current) {
        if (liveMediaSourceIds.has(id)) continue;
        renderer.dispose();
        target.dispose();
        sharedMediaRenderersRef.current.delete(id);
      }
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
    // Baseline for playback frame-interval telemetry (frame-stats.ts). Reset across pauses/suspends so
    // a pause gap is never counted as a "frame". Measurement only — no effect on the render itself.
    let lastPlayingFrameTs = 0;
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
        lastPlayingFrameTs = 0;
      } else {
        if (wasSuspended) {
          wasSuspended = false;
          requestDraw();
        }
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        const playingFrame = inputsRef.current.isPlaying;
        if (playingFrame || now < activeUntilRef.current) {
          drawRef.current();
          // Playback smoothness telemetry: interval between composited playback frames + composite CPU
          // cost. Feeds the Stats HUD and the adaptive quality controller. Skipped for settle-window
          // (paused) draws and after a failed frame, so it only ever measures real playback frames.
          if (playingFrame && !failedRef.current && !contextLostRef.current) {
            const end = typeof performance !== "undefined" ? performance.now() : Date.now();
            if (lastPlayingFrameTs > 0) recordPlaybackFrame(now - lastPlayingFrameTs, end - now);
            lastPlayingFrameTs = now;
          }
          // A sustained run of clean frames after a rebuild restores the full retry budget.
          if (rebuildAttemptsRef.current > 0 && !failedRef.current && !contextLostRef.current) {
            goodFramesRef.current += 1;
            if (goodFramesRef.current >= HEALTHY_FRAMES_TO_RESET) {
              rebuildAttemptsRef.current = 0;
              goodFramesRef.current = 0;
            }
          }
        }
        if (!playingFrame) lastPlayingFrameTs = 0;
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

  // Publish the viewer-capture handle (todo.md Phase 6B P1a). Methods read live refs, so one stable object
  // stays valid across recoveries — each call re-checks the compositor before touching the GPU.
  useEffect(() => {
    if (!captureRef) return undefined;
    const releaseCaptureResources = () => {
      for (const [id, { renderer, target }] of sharedGradeRenderersRef.current) {
        if (!id.startsWith("capture:")) continue;
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
        sharedGradeRenderersRef.current.delete(id);
      }
    };
    const handle: SceneViewerCaptureHandle = {
      getSharedGl() {
        const compositor = compositorRef.current;
        if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return null;
        return compositor.sharedGl;
      },
      async ensureTextRasters(ls, timeSeconds) {
        const rasterizer = rasterizerRef.current;
        if (!rasterizer) return;
        const { width: w, height: h } = inputsRef.current;
        await Promise.all(
          ls
            .filter((layer) => layer.type === "text" || layer.type === "shape")
            .map(async (layer) => {
              // boxMode must match buildSceneDraws' own computation (blur/glow → comp-sized raster).
              const fx = getCompositionFilterEffects(layer, { currentTimeSeconds: timeSeconds });
              const boxMode = !(fx.blurPx > 0 || fx.glow);
              await rasterizer.ensure(layer, timeSeconds, w, h, boxMode);
            })
        );
      },
      renderOffscreen({ layers: ls, timeSeconds: t, transitions: tPairs, getMediaGraded, buffer }) {
        const compositor = compositorRef.current;
        if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return null;
        const { width: w, height: h, backgroundColor: bg, renderScale: rScale, nestedGroups: nestGroups } = inputsRef.current;
        const renderW = Math.max(1, Math.round(w * rScale));
        const renderH = Math.max(1, Math.round(h * rScale));
        try {
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
            getMediaGraded,
            gradeOverlay: makeGradeOverlayRef.current(compositor, "capture:"),
            createCanvas: () => document.createElement("canvas"),
            regionPassModel: getRegionPassesEnabled(),
            // Same live composition's groups (this capture renders THIS viewer's own layer set at another
            // time — see the handle's docstring); matte-cache pool shared with the live path exactly like
            // `matteCacheRef` already is above (re-keys per (layer, tLocal), so alternating just re-hashes,
            // never corrupts — the same trade-off the pre-existing code already accepts for `matteCacheRef`).
            nestedGroups: nestGroups,
            nestMatteCaches: nestMatteCachesRef.current,
          });
          return compositor.renderFrameOffscreen(
            { width: renderW, height: renderH, backgroundColor: bg, layers: draws, debugFrameTime: t },
            buffer
          );
        } catch {
          // A lost context is detected/recovered by the render loop; the capture caller just retries/fails.
          return null;
        }
      },
      readCompositeThumbnail(targetW, targetH, buffer) {
        const compositor = compositorRef.current;
        if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return null;
        try {
          // Async PBO readback (no GPU-drain stall) is part of the single-ctx preview package and gated with
          // it — with the flag OFF the shipped scopes stay on the EXACT synchronous path, byte-for-byte. When
          // ON, prefer async and fall back to the sync read during warm-up (before the first fence completes).
          if (singleCtxMedia) {
            return (
              compositor.readCompositeThumbnailAsync(targetW, targetH, buffer) ??
              compositor.readCompositeThumbnail(targetW, targetH, buffer)
            );
          }
          return compositor.readCompositeThumbnail(targetW, targetH, buffer);
        } catch {
          return null;
        }
      },
      releaseCaptureResources,
    };
    captureRef.current = handle;
    return () => {
      if (captureRef.current === handle) captureRef.current = null;
      releaseCaptureResources();
    };
  }, [captureRef]);

  // Non-interactive: selection boxes / motion-path handles are separate DOM overlays that must stay
  // clickable above this canvas.
  const style: CSSProperties = { position: "absolute", left: 0, top: 0, width, height, pointerEvents: "none" };
  // key={recoveryTick}: a recovery rebuild REMOUNTS the canvas element. getContext() on a canvas
  // whose context was lost returns the SAME dead context (see releaseContextIfDetached docs), so
  // rebuilding on the old element could only ever work if the browser had already restored it —
  // a fresh element gets a genuinely fresh context on every retry of the recovery ladder.
  return <canvas key={recoveryTick} ref={canvasRef} className="preview-scene-canvas" style={style} aria-hidden="true" />;
}
