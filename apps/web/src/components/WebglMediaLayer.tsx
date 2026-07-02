import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { MediaWebGLRenderer, registerContextDisposer, type ColorPipeline, type MatteRef, type MediaEffects, type MediaTransition } from "@lumio-by-aelivion/shared";

/**
 * Unified WebGL media layer for the editor preview (flag-gated, rendererMode=webgl).
 *
 * Replaces three legacy components in a single pass:
 *   - `WebglColorView` (image color grading)
 *   - `WebglVideoOverlay` (video color grading)
 *   - `MaskedVideoLayer` (canvas-2D matte compositing, no color)
 *
 * One `MediaWebGLRenderer` does: color grading (3D LUT) + matte compositing (luma
 * texture) + layer opacity — all in a single WebGL fragment shader pass. No
 * double-grading: the hidden source element has `skipColorFilter:true` in its style
 * so only the canvas output carries the grade.
 *
 * Object-fit, CSS transforms, and warp text overlay remain CSS/DOM (unchanged).
 * The visible `<canvas>` receives the same style as the source element would have,
 * so layout (position, transform, objectFit) is CSS-identical to the legacy path.
 *
 * Fallback: if WebGL context creation fails, `failedRef` flips to true and the caller
 * (VideoPreview.tsx) falls back to the legacy SVG-filter path. No silent failure.
 */

type VideoFrameCapableElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

interface BaseProps {
  pipeline: ColorPipeline | null;
  /** Pro stylize effects (vignette/grain/chroma) applied in the same shader pass. */
  mediaEffects?: MediaEffects | null;
  amount?: number;
  /** Full style from getCompositionMediaStyle(..., { skipColorFilter: true }). */
  style: CSSProperties;
  className?: string | undefined;
  dragHandlers?: HTMLAttributes<HTMLCanvasElement> | undefined;
  onWebglFailed?: (() => void) | undefined;
  /** First-frame still shown over the canvas until the first real frame paints (no black gap). */
  poster?: string | undefined;
  /** GPU wipe/iris reveal for an incoming transition clip (from getCompositionTransition). */
  transition?: MediaTransition | null | undefined;
  /**
   * Pre-roll/pending flag: hide the canvas via CSS visibility WITHOUT zeroing the shader opacity, so the
   * buffer keeps holding a real, full-opacity frame. Revealing it (hidden→false) is then a pure CSS flip
   * with correct pixels already present — no transparent-buffer flicker at the cut.
   */
  hidden?: boolean | undefined;
  /**
   * Scene-composited media: the GPU SceneCompositor draws this clip, so hide the DOM canvas via `opacity:0`
   * (NOT `visibility:hidden`) so it stays pointer-INTERACTIVE — click-to-select on the preview still works,
   * like text/shape. The shader keeps drawing the real frame (the scene path reads it as a texture). Ignored
   * while `hidden` (pending/pre-roll) is set — that needs visibility:hidden (no early paint, no interaction).
   */
  interactiveHidden?: boolean | undefined;
  /**
   * Called after each successful draw with the graded canvas, so a parent (the transition compositor) can
   * sample it as the `from`/`to` texture of a two-clip GPU mix. The canvas is sized to the SOURCE
   * resolution and carries the full grade (LUT + matte + opacity), straight-alpha sRGB.
   */
  onGradedFrame?: ((canvas: HTMLCanvasElement) => void) | undefined;
  /**
   * Whether to BAKE the layer opacity into the graded canvas (default true). The scene compositor sets
   * this false for the media it composites: it applies opacity LIVE at composite time (like
   * position/scale and like text/shape), so opacity is never stale on a seek/pause (a `currentTime`
   * change doesn't re-grade, but it DOES recomposite). DOM display + transition sources keep baking.
   */
  bakeOpacity?: boolean | undefined;
}

interface ImageProps extends BaseProps {
  mediaType: "image";
  src: string;
  matte?: MatteRef | undefined;
  currentTime?: never;
  isPlaying?: never;
  layerStartSeconds?: never;
  sourceInSeconds?: never;
  onLoadedMetadata?: never;
}

interface VideoProps extends BaseProps {
  mediaType: "video";
  src: string;
  matte?: MatteRef | undefined;
  currentTime: number;
  isPlaying: boolean;
  layerStartSeconds: number;
  sourceInSeconds?: number | undefined;
  onLoadedMetadata?: ((event: React.SyntheticEvent<HTMLVideoElement>) => void) | undefined;
}

type WebglMediaLayerProps = ImageProps | VideoProps;

export const WebglMediaLayer = forwardRef<HTMLVideoElement | null, WebglMediaLayerProps>(
  function WebglMediaLayer(props, forwardedRef) {
    const {
      mediaType, src, matte, pipeline, mediaEffects = null, amount = 1, style, className,
      dragHandlers, onWebglFailed, poster, hidden = false, interactiveHidden = false, transition = null, onGradedFrame,
      bakeOpacity = true,
    } = props;

    // Latest onGradedFrame, read inside the draw loop (whose closure would otherwise be stale).
    const onGradedFrameRef = useRef(onGradedFrame);
    onGradedFrameRef.current = onGradedFrame;

    // The canvas is blank until the first frame is drawn; a poster covers exactly that gap so the
    // viewer never shows black (at the start, at a cut, or on seek). Reset when the source changes.
    const [firstPainted, setFirstPainted] = useState(false);
    useEffect(() => {
      setFirstPainted(false);
    }, [src]);

    // Latest stylize params, read inside the rAF/vfc draw loop (whose closure would
    // otherwise be stale) so keyframed vignette + animated grain track playback.
    const mediaEffectsRef = useRef<MediaEffects | null>(mediaEffects);
    mediaEffectsRef.current = mediaEffects;

    // The transition reveal changes every frame; the playing draw loop reads the latest from this ref.
    const transitionRef = useRef<MediaTransition | null>(transition);
    transitionRef.current = transition;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rendererRef = useRef<MediaWebGLRenderer | null>(null);
    const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
    const matteVideoRef = useRef<HTMLVideoElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const rafRef = useRef<number | null>(null);
    const vfcRef = useRef<number | null>(null);
    const disposeTimerRef = useRef<number | null>(null);
    const failedRef = useRef(false);
    // The playback loop closes over this ref so it always invokes the CURRENT drawVideoFrame — which
    // reads live opacity/transform from `style`. Without it the loop froze the opacity captured when it
    // started (≈0 at a transition's fade-in start), leaving the incoming clip transparent → black.
    const drawVideoFrameRef = useRef<() => void>(() => {});

    // Expose the source video element so VideoPreview's play/pause/seek effects keep working.
    useImperativeHandle(forwardedRef, () => sourceVideoRef.current as HTMLVideoElement, []);

    /**
     * Get the renderer, lazily (re)creating it when absent. Absent means either first mount OR the context
     * governor evicted this layer's context under budget pressure — in which case we transparently recreate
     * it here the next time the clip is actually drawn (it's back in the active window). A freshly created
     * context has no baked LUT, so we re-apply the current grade immediately. Returns null once `failedRef`
     * (a real WebGL failure → legacy fallback) or when there's no canvas yet.
     */
    function ensureRenderer(): MediaWebGLRenderer | null {
      if (failedRef.current) return null;
      const existing = rendererRef.current;
      if (existing) return existing;
      const canvas = canvasRef.current;
      if (!canvas) return null;
      let renderer: MediaWebGLRenderer;
      try {
        renderer = new MediaWebGLRenderer(canvas, { kind: "media-renderer", label: `preview-media:${mediaType}:${src}` });
      } catch {
        rendererRef.current = null;
        failedRef.current = true;
        onWebglFailed?.();
        return null;
      }
      rendererRef.current = renderer;
      // The pipeline effect only fires on pipelineKey CHANGES, so after a governor recreate the grade would
      // otherwise be missing until the next edit — re-bake it now.
      try { renderer.setPipeline(pipeline); } catch { /* a bad pipeline must not kill the layer */ }
      // Let the governor reclaim THIS renderer's context under budget pressure. Unlike a real context loss
      // (which latches `failedRef` → legacy fallback), an eviction merely drops the renderer so `ensureRenderer`
      // lazily recreates it on the next draw once the clip is active again — the LRU dance that bounds contexts.
      const gl = renderer.governorContext;
      if (gl) {
        registerContextDisposer(gl, () => {
          stopLoop();
          if (rendererRef.current === renderer) rendererRef.current = null;
          try { renderer.dispose(); } catch { /* ignore */ }
        });
      }
      return renderer;
    }

    // Create / destroy the renderer with the canvas.
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;
      const handleContextLost = (event: Event) => {
        event.preventDefault();
        failedRef.current = true;
        stopLoop();
        const renderer = rendererRef.current;
        rendererRef.current = null;
        try { renderer?.dispose(); } catch { /* ignore */ }
        onWebglFailed?.();
      };
      canvas.addEventListener("webglcontextlost", handleContextLost);
      if (disposeTimerRef.current !== null) {
        window.clearTimeout(disposeTimerRef.current);
        disposeTimerRef.current = null;
      }
      ensureRenderer();
      return () => {
        canvas.removeEventListener("webglcontextlost", handleContextLost);
        stopLoop();
        scheduleRendererDispose();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Bake a new LUT whenever the pipeline changes.
    const pipelineKey = JSON.stringify(pipeline);
    useEffect(() => {
      if (failedRef.current) return;
      try {
        rendererRef.current?.setPipeline(pipeline);
        if (mediaType === "image") drawImage();
        // A playing video repaints on the next rAF/vfc tick, but a PAUSED video (the usual
        // state while grading) must be repainted now or the new grade never shows.
        else if (mediaType === "video" && !(props as VideoProps).isPlaying) drawVideoFrame();
      } catch {
        failedRef.current = true;
        onWebglFailed?.();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pipelineKey]);

    // Stylize params (vignette/grain/chroma) are plain uniforms, not a baked LUT — so a
    // change just needs a redraw. The playing video loop already redraws every frame.
    const mediaEffectsKey = JSON.stringify(mediaEffects);
    useEffect(() => {
      if (failedRef.current) return;
      if (mediaType === "image") drawImage();
      else if (mediaType === "video" && !(props as VideoProps).isPlaying) drawVideoFrame();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaEffectsKey]);

    // `opacity` (from `style`), effect `amount`, and the matte params are BAKED into the grade by
    // drawVideoFrame/drawImage but — unlike pipeline/mediaEffects/transition above — had NO paused-repaint
    // trigger. So editing them WHILE PAUSED re-rendered the component without repainting the canvas (it
    // only refreshed once you played, where the per-frame loop re-grades every frame). Keying on their
    // VALUES (not object identity, so no spurious redraws) repaints a paused frame on any change, making
    // every baked draw input real-time. Covers the reported opacity bug + the same class for the others.
    const bakedInputsKey = `${extractOpacity(style)}|${amount}|${matte?.invert ?? false}|${matte?.opacity ?? 1}`;
    useEffect(() => {
      if (failedRef.current) return;
      if (mediaType === "image") drawImage();
      else if (mediaType === "video" && !(props as VideoProps).isPlaying) drawVideoFrame();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bakedInputsKey]);

    // ─── IMAGE PATH ──────────────────────────────────────────────────────────

    useEffect(() => {
      if (mediaType !== "image") return undefined;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        imageRef.current = img;
        drawImage();
      };
      img.src = src;
      return () => { img.onload = null; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, mediaType]);

    function drawImage() {
      if (failedRef.current) return;
      const renderer = ensureRenderer();
      const img = imageRef.current;
      if (!renderer || !img || img.naturalWidth === 0) return;
      try {
        renderer.draw({
          source: img,
          sourceWidth: img.naturalWidth,
          sourceHeight: img.naturalHeight,
          pipeline,
          amount,
          opacity: bakeOpacity ? extractOpacity(style) : 1,
          mediaEffects: mediaEffectsRef.current,
          transition: transitionRef.current,
        });
        setFirstPainted(true);
        if (canvasRef.current) onGradedFrameRef.current?.(canvasRef.current);
      } catch {
        failedRef.current = true;
        onWebglFailed?.();
      }
    }

    // A wipe/iris reveal changes per frame; repaint a still image (or paused video) when it changes.
    const transitionKey = JSON.stringify(transition);
    useEffect(() => {
      if (failedRef.current) return;
      if (mediaType === "image") drawImage();
      else if (mediaType === "video" && !(props as VideoProps).isPlaying) drawVideoFrame();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [transitionKey]);

    // ─── VIDEO PATH ──────────────────────────────────────────────────────────

    const currentTime = mediaType === "video" ? props.currentTime : 0;
    const isPlaying = mediaType === "video" ? props.isPlaying : false;
    const layerStartSeconds = mediaType === "video" ? props.layerStartSeconds : 0;
    const sourceInSeconds = mediaType === "video" ? (props.sourceInSeconds ?? 0) : 0;

    // Sync matte video time to source video.
    useEffect(() => {
      if (mediaType !== "video" || !matte?.uri) return;
      const matteVideo = matteVideoRef.current;
      if (!matteVideo) return;
      const nextTime = sourceInSeconds + Math.max(0, currentTime - layerStartSeconds);
      if (Number.isFinite(nextTime) && Math.abs(matteVideo.currentTime - nextTime) > 0.08) {
        matteVideo.currentTime = nextTime;
      }
    }, [currentTime, layerStartSeconds, mediaType, matte?.uri, sourceInSeconds]);

    // Play/pause the matte video in sync with the source.
    useEffect(() => {
      if (mediaType !== "video" || !matte?.uri) return;
      const matteVideo = matteVideoRef.current;
      if (!matteVideo) return;
      if (isPlaying) {
        void matteVideo.play().catch(() => undefined);
      } else {
        matteVideo.pause();
      }
    }, [isPlaying, mediaType, matte?.uri]);

    // Redraw a paused video frame on seek.
    useEffect(() => {
      if (mediaType !== "video" || isPlaying) return;
      drawVideoFrame();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentTime, isPlaying, mediaType]);

    // Repaint as soon as the source video has a real frame decoded (load / seek complete).
    // Without this the canvas shows nothing until the next rAF/seek tick, so the first frame
    // of a clip — and the first frame after a cut — flashes black. Mirrors how a <video>
    // element would paint its own first frame in the legacy path.
    useEffect(() => {
      if (mediaType !== "video") return undefined;
      const video = sourceVideoRef.current;
      if (!video) return undefined;
      const repaint = () => drawVideoFrame();
      video.addEventListener("loadeddata", repaint);
      video.addEventListener("canplay", repaint);
      video.addEventListener("seeked", repaint);
      // The frame may already be available (cached/instant) before listeners attach.
      if (video.readyState >= 2) drawVideoFrame();
      return () => {
        video.removeEventListener("loadeddata", repaint);
        video.removeEventListener("canplay", repaint);
        video.removeEventListener("seeked", repaint);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaType, src]);

    // Frame loop while playing.
    useEffect(() => {
      if (mediaType !== "video" || !isPlaying) return undefined;
      const video = sourceVideoRef.current as VideoFrameCapableElement | null;
      let active = true;

      if (video?.requestVideoFrameCallback) {
        const tick = () => {
          if (!active) return;
          drawVideoFrameRef.current();
          vfcRef.current = video.requestVideoFrameCallback!(tick);
        };
        vfcRef.current = video.requestVideoFrameCallback(tick);
        return () => {
          active = false;
          if (vfcRef.current != null) video.cancelVideoFrameCallback?.(vfcRef.current);
        };
      }

      const loop = () => {
        if (!active) return;
        drawVideoFrameRef.current();
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return () => {
        active = false;
        stopLoop();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPlaying, mediaType]);

    function stopLoop() {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    }

    function scheduleRendererDispose() {
      const renderer = rendererRef.current;
      if (!renderer) return;
      if (disposeTimerRef.current !== null) window.clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = window.setTimeout(() => {
        disposeTimerRef.current = null;
        if (rendererRef.current === renderer) rendererRef.current = null;
        try { renderer.dispose(); } catch { /* ignore */ }
      }, 0);
    }

    function drawVideoFrame() {
      if (failedRef.current || mediaType !== "video") return;
      const renderer = ensureRenderer();
      const video = sourceVideoRef.current;
      if (!renderer || !video || video.readyState < 2 || video.videoWidth === 0) return;
      const matteVideo = matteVideoRef.current;
      const hasMatte = Boolean(matte?.uri) && matteVideo !== null && matteVideo.readyState >= 2;
      try {
        renderer.draw({
          source: video,
          sourceWidth: video.videoWidth,
          sourceHeight: video.videoHeight,
          matte: hasMatte ? matteVideo : null,
          matteInvert: matte?.invert ?? false,
          matteOpacity: matte?.opacity ?? 1,
          pipeline,
          amount,
          opacity: bakeOpacity ? extractOpacity(style) : 1,
          mediaEffects: mediaEffectsRef.current,
          transition: transitionRef.current,
        });
        setFirstPainted(true);
        if (canvasRef.current) onGradedFrameRef.current?.(canvasRef.current);
      } catch {
        failedRef.current = true;
        onWebglFailed?.();
      }
    }
    // Keep the loop's draw reference current so playback reads live opacity/transform every frame.
    drawVideoFrameRef.current = drawVideoFrame;

    // ─── RENDER ──────────────────────────────────────────────────────────────

    // The canvas keeps the layout style (left, top, objectFit, transform) AND the stylize CSS `filter`
    // (blur / glow). Color grading is shader-baked and already excluded upstream (skipColorFilter:true), so
    // `style.filter` here is only the non-color filters — they must stay or blur/glow would never render.
    // Interaction events pass through so the existing drag/selection handlers on the parent still fire.
    // `hidden` (pre-roll) hides the canvas via visibility only — never via opacity, which the shader
    // bakes in: a transparent-drawn buffer is exactly what flickers at the reveal. visibility:hidden also
    // makes it non-interactive. The shader still draws the real frame so the buffer is reveal-ready.
    const canvasStyle: CSSProperties = {
      ...style,
      pointerEvents: dragHandlers ? undefined : "none",
      ...(hidden ? { visibility: "hidden" } : interactiveHidden ? { opacity: 0 } : {}),
    };

    return (
      <>
        {mediaType === "video" && (
          <>
            <video
              ref={sourceVideoRef}
              crossOrigin="anonymous"
              src={src}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={props.onLoadedMetadata}
              style={{ display: "none" }}
            />
            {matte?.uri ? (
              <video
                ref={matteVideoRef}
                crossOrigin="anonymous"
                src={matte.uri}
                muted
                playsInline
                preload="auto"
                style={{ display: "none" }}
              />
            ) : null}
          </>
        )}
        <canvas
          ref={canvasRef}
          className={className}
          style={canvasStyle}
          aria-hidden="true"
          {...dragHandlers}
        />
        {poster && !firstPainted && !hidden ? (
          <img
            src={poster}
            alt=""
            aria-hidden="true"
            draggable={false}
            // Same positioning class as the canvas → position:absolute, so the inline
            // translate(-50%,-50%) centers it instead of shoving a static-flow image to the top-left
            // (the "footage flashes small in the corner on every cut" bug).
            className="preview-media"
            style={{ ...canvasStyle, pointerEvents: "none" }}
          />
        ) : null}
      </>
    );
  }
);

/** Extract the numeric opacity already baked into the style by getCompositionMediaStyle. */
function extractOpacity(style: CSSProperties): number {
  const v = style.opacity;
  if (v == null) return 1;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 1;
}
