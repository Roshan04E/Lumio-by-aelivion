import { useEffect, useRef, type CSSProperties, type MutableRefObject } from "react";
import {
  getActiveTransition,
  getTransition,
  TransitionCompositor,
  type TransitionSpec,
} from "@lumio-by-aelivion/shared";

/**
 * Editor-preview overlay for the unified GPU transition engine.
 *
 * The two clips of a junction transition keep rendering through their normal `WebglMediaLayer`s (so all
 * the video seek / preload / matte / grade machinery is reused) but report their graded canvases via
 * `onGradedFrame` into `gradedRef`. This overlay owns ONE `TransitionCompositor`, reads those two graded
 * canvases as the `from`/`to` textures, and draws the two-texture mix into a single visible canvas on top.
 *
 * Progress + params come from the shared `getActiveTransition` (the same call export/Remotion use), so the
 * preview blend is computed identically to the rendered output.
 */
interface TransitionOverlayProps {
  spec: TransitionSpec;
  /** Incoming clip start = the cut. The transition window is [startSeconds, startSeconds+duration]. */
  startSeconds: number;
  /** Incoming clip length — clamps the window so the reveal never runs past the clip. */
  clipDurationSeconds: number;
  currentTime: number;
  isPlaying: boolean;
  /** Composition pixel size (the compositor renders at this resolution). */
  width: number;
  height: number;
  /** Outgoing (from) and incoming (to) layer ids — keys into `gradedRef`. */
  fromId: string;
  toId: string;
  /** Object-fit of each clip so the mix matches the clips' normal rendering (no squeeze at the boundary). */
  fromFit: "cover" | "contain" | "fill";
  toFit: "cover" | "contain" | "fill";
  gradedRef: MutableRefObject<Record<string, HTMLCanvasElement | null>>;
}

export function TransitionOverlay({
  spec,
  startSeconds,
  clipDurationSeconds,
  currentTime,
  isPlaying,
  width,
  height,
  fromId,
  toId,
  fromFit,
  toFit,
  gradedRef,
}: TransitionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<TransitionCompositor | null>(null);
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;

  const def = getTransition(spec.kind);

  // Create / dispose the compositor with the canvas. Pre-warm the program so the first cut doesn't hitch.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    try {
      const compositor = new TransitionCompositor(canvas);
      if (def) compositor.prepare(def);
      compositorRef.current = compositor;
    } catch {
      compositorRef.current = null;
    }
    return () => {
      try {
        compositorRef.current?.dispose();
      } catch {
        /* ignore */
      }
      compositorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def?.id]);

  function drawMix() {
    const compositor = compositorRef.current;
    if (!compositor || !def) return;
    const active = getActiveTransition(spec, { currentTimeSeconds: timeRef.current, startSeconds, clipDurationSeconds });
    if (!active) return;
    const from = gradedRef.current[fromId];
    const to = gradedRef.current[toId];
    if (!from || !to) return;
    try {
      compositor.draw(def, {
        from,
        to,
        width,
        height,
        transitionId: active.transitionId,
        progress: active.progress,
        params: active.params,
        fromFit,
        toFit,
      });
    } catch {
      /* a transient texture-not-ready error self-heals next frame */
    }
  }

  // Drive the mix every frame while playing (both source canvases preserve their last frame, so a stale
  // side never flashes). When paused/scrubbing, redraw on a rAF after the source layers have repainted.
  useEffect(() => {
    if (isPlaying) {
      let active = true;
      const loop = () => {
        if (!active) return;
        drawMix();
        raf = requestAnimationFrame(loop);
      };
      let raf = requestAnimationFrame(loop);
      return () => {
        active = false;
        cancelAnimationFrame(raf);
      };
    }
    const raf = requestAnimationFrame(drawMix);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, currentTime, fromId, toId, spec, startSeconds, width, height]);

  // No z-index: the overlay is rendered in DOM order right after the transitioning clips' track, so it
  // covers both clips but stays UNDER any higher-track text/graphics (which come later in the DOM).
  const style: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  };

  return <canvas ref={canvasRef} width={width} height={height} aria-hidden="true" style={style} />;
}
