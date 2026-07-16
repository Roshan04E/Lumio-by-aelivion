import { useEffect, useRef, type CSSProperties, type MutableRefObject } from "react";
import {
  getActiveTransition,
  getCompositionTransform,
  getTransition,
  TransitionCompositor,
  type TimelineLayer,
  type TransitionSpec,
} from "@kimera-by-aelivion/shared";

/**
 * Editor-preview overlay for the unified GPU transition engine (DOM fallback path only — scene mode
 * folds junction mixes in-compositor via `SceneCompositor.drawTransition`).
 *
 * The two clips of a junction transition keep rendering through their normal `WebglMediaLayer`s (so all
 * the video seek / preload / matte / grade machinery is reused) but report their graded canvases via
 * `onGradedFrame` into `gradedRef`. This overlay owns ONE `TransitionCompositor`, reads those two graded
 * canvases as the `from`/`to` textures, and draws the two-texture mix into a single visible canvas on top.
 *
 * Progress + params come from the shared `getActiveTransition` (the same call the scene path uses), so the
 * preview blend is computed identically to the rendered output.
 *
 * TRANSFORM PARITY: a graded canvas is the pre-transform clip image — in normal (non-transition) frames
 * the clip's position/scale/rotation is applied as CSS on the element (`getCompositionMediaStyle` →
 * `left/top: x%/y%` + `translate(-50%,-50%) rotate scale`, object-fit inside the comp-sized box). If the
 * mix consumed the raw canvases, a transformed clip would snap to full-frame at the window boundary. So
 * each side is PRE-BAKED through exactly that CSS geometry into a comp-sized 2D canvas and the mix runs
 * with fit "fill" — mirroring the scene path's nest pre-compose (sides pre-baked, fit hardcoded (1,1)).
 * Identity-transform clips skip the bake and feed the shader directly, exactly as before.
 * Known fallback-only limits (matching what the DOM element path itself renders): 3D tilt
 * (rotateX/rotateY/perspective/z) is approximated by its 2D part; content pan/zoom/crop is not applied
 * (the DOM element style doesn't apply it either, so the window matches the surrounding frames).
 */
interface TransitionOverlayProps {
  spec: TransitionSpec;
  /** Incoming clip start = the cut. R3: the transition window is centered on it, [cut - D/2, cut + D/2]
   *  (see `getActiveTransition`'s doc) — `startSeconds` here is the CUT, not the window start. */
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
  /** The two timeline layers — drive the per-frame transform evaluation for the pre-bake. */
  fromLayer: TimelineLayer;
  toLayer: TimelineLayer;
  gradedRef: MutableRefObject<Record<string, HTMLCanvasElement | null>>;
}

function sourceSize(source: HTMLCanvasElement): { w: number; h: number } {
  return { w: source.width, h: source.height };
}

/** Identity check — matches `getCompositionMediaStyle`'s defaults (x/y 50%, scale 1, rotation 0). */
function isIdentity(t: { x: number; y: number; scale: number; rotation: number }): boolean {
  return t.x === 50 && t.y === 50 && t.scale === 1 && t.rotation === 0;
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
  fromLayer,
  toLayer,
  gradedRef,
}: TransitionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<TransitionCompositor | null>(null);
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;
  // One reusable comp-sized 2D canvas per side (allocated on first transformed frame, resized on demand).
  const bakeCanvasesRef = useRef<[HTMLCanvasElement | null, HTMLCanvasElement | null]>([null, null]);

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

  /**
   * Reproduce the clip's normal DOM rendering (comp-sized box at `x%,y%`, centered, rotated, scaled,
   * object-fit inside the box) into a comp-sized canvas. Returns the source unchanged for identity
   * transforms so the untransformed fast path is byte-identical to the pre-fix behavior.
   */
  function bakeSide(
    source: HTMLCanvasElement,
    layer: TimelineLayer,
    fit: "cover" | "contain" | "fill",
    slot: 0 | 1
  ): { image: HTMLCanvasElement; fit: "cover" | "contain" | "fill" } {
    const t = getCompositionTransform(layer, { currentTimeSeconds: timeRef.current });
    if (isIdentity(t)) {
      return { image: source, fit };
    }
    let target = bakeCanvasesRef.current[slot];
    if (!target) {
      target = document.createElement("canvas");
      bakeCanvasesRef.current[slot] = target;
    }
    if (target.width !== width || target.height !== height) {
      target.width = width;
      target.height = height;
    }
    const ctx = target.getContext("2d");
    if (!ctx) {
      return { image: source, fit };
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { w: sw, h: sh } = sourceSize(source);
    if (sw <= 0 || sh <= 0) {
      return { image: source, fit };
    }
    // Object-fit maps the source into the comp-sized element box (drawn size dw×dh, box-clipped).
    let dw = width;
    let dh = height;
    if (fit !== "fill") {
      const s = fit === "cover" ? Math.max(width / sw, height / sh) : Math.min(width / sw, height / sh);
      dw = sw * s;
      dh = sh * s;
    }
    ctx.save();
    // CSS order: position the box center at (x%, y%), then rotate, then scale (translate3d(-50%,-50%)
    // centers the box, so everything below is box-center-relative).
    ctx.translate((t.x / 100) * width, (t.y / 100) * height);
    ctx.rotate((t.rotation * Math.PI) / 180);
    ctx.scale(t.scale, t.scale);
    // The element's content box clips object-fit overflow (cover) — clip to the box before drawing.
    ctx.beginPath();
    ctx.rect(-width / 2, -height / 2, width, height);
    ctx.clip();
    ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    // Geometry is now pre-baked at comp size — the shader must not re-fit it.
    return { image: target, fit: "fill" };
  }

  function drawMix() {
    const compositor = compositorRef.current;
    if (!compositor || !def) return;
    const active = getActiveTransition(spec, { currentTimeSeconds: timeRef.current, startSeconds, clipDurationSeconds });
    if (!active) return;
    const from = gradedRef.current[fromId];
    const to = gradedRef.current[toId];
    if (!from || !to) return;
    try {
      const bakedFrom = bakeSide(from, fromLayer, fromFit, 0);
      const bakedTo = bakeSide(to, toLayer, toFit, 1);
      compositor.draw(def, {
        from: bakedFrom.image,
        to: bakedTo.image,
        width,
        height,
        transitionId: active.transitionId,
        progress: active.progress,
        params: active.params,
        fromFit: bakedFrom.fit,
        toFit: bakedTo.fit,
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
  }, [isPlaying, currentTime, fromId, toId, spec, startSeconds, width, height, fromLayer, toLayer]);

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
