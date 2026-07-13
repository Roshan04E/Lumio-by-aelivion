import type { CSSProperties } from "react";
import type { TransitionDirection, TransitionKind } from "@kimera-by-aelivion/shared";

/**
 * Pure recipe that maps a transition (kind + params) and a 0..1 progress to CSS for a small gallery
 * preview tile: the A (outgoing, under) layer, the B (incoming, over) layer, and an optional colour
 * overlay (dip). It mirrors the real transition semantics — direction/mode mapping matches
 * `buildTransitionAnimations` and the media shader — but renders with cheap CSS transform/opacity/
 * clip-path so a whole gallery of tiles stays lightweight (no per-tile WebGL). This is a thumbnail
 * approximation only; the actual editor/export render still uses the GPU/keyframe engine.
 */

export interface TransitionPreviewParams {
  direction?: TransitionDirection | undefined;
  mode?: "in" | "out" | undefined;
  color?: string | undefined;
}

export interface TransitionPreviewLayers {
  /** Outgoing clip layer (drawn under). */
  a: CSSProperties;
  /** Incoming clip layer (drawn over). */
  b: CSSProperties;
  /** Dip-through colour overlay, or null. */
  overlay: CSSProperties | null;
}

const FILL: CSSProperties = { position: "absolute", inset: 0 };

/** Smooth easeInOut so the preview motion reads nicely. */
function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Off-screen translate (percent) for a direction, scaled by `amt` (1 = fully off, 0 = centred). */
function edgeOffset(direction: TransitionDirection, amt: number): { x: number; y: number } {
  switch (direction) {
    case "left":
      return { x: -100 * amt, y: 0 };
    case "right":
      return { x: 100 * amt, y: 0 };
    case "up":
      return { x: 0, y: -100 * amt };
    case "down":
    default:
      return { x: 0, y: 100 * amt };
  }
}

/** `clip-path: inset(...)` revealing the B layer along a wipe direction at eased progress `e`. */
function wipeInset(direction: TransitionDirection, e: number): string {
  const hidden = `${((1 - e) * 100).toFixed(1)}%`;
  switch (direction) {
    case "left":
      return `inset(0 0 0 ${hidden})`; // reveal from the right edge inward
    case "right":
      return `inset(0 ${hidden} 0 0)`; // reveal from the left edge inward
    case "up":
      return `inset(${hidden} 0 0 0)`; // reveal from the bottom up
    case "down":
    default:
      return `inset(0 0 ${hidden} 0)`; // reveal from the top down
  }
}

export function transitionPreviewStyle(
  kind: TransitionKind,
  params: TransitionPreviewParams,
  progress: number
): TransitionPreviewLayers {
  const p = Math.max(0, Math.min(1, progress));
  const e = ease(p);
  const direction = params.direction ?? "right";
  const mode = params.mode ?? "in";

  const a: CSSProperties = { ...FILL };
  let b: CSSProperties = { ...FILL };
  let overlay: CSSProperties | null = null;

  switch (kind) {
    case "fadeIn":
    case "fadeOut":
    case "crossDissolve":
      b = { ...FILL, opacity: e };
      break;
    case "slide": {
      const off = edgeOffset(direction, 1 - e);
      b = { ...FILL, transform: `translate(${off.x}%, ${off.y}%)` };
      break;
    }
    case "push": {
      const inOff = edgeOffset(direction, 1 - e); // incoming enters from the edge
      const outOff = edgeOffset(direction, -e); // outgoing leaves the opposite edge, locked
      b = { ...FILL, transform: `translate(${inOff.x}%, ${inOff.y}%)` };
      a.transform = `translate(${outOff.x}%, ${outOff.y}%)`;
      break;
    }
    case "zoom": {
      const from = mode === "out" ? 0.7 : 1.35;
      const scale = from + (1 - from) * e;
      b = { ...FILL, transform: `scale(${scale.toFixed(3)})`, opacity: Math.min(1, e * 1.6) };
      break;
    }
    case "wipe":
      b = { ...FILL, clipPath: wipeInset(direction, e) };
      break;
    case "iris": {
      // Both grow a centred disc; "out" starts wider so it reads differently from "in".
      const radius = mode === "out" ? 35 + e * 55 : e * 82;
      b = { ...FILL, clipPath: `circle(${radius.toFixed(1)}% at 50% 50%)` };
      break;
    }
    case "dip": {
      const color = params.color ?? "#000000";
      const colorAmt = Math.max(0, 1 - Math.abs(p - 0.5) * 2); // peaks at the midpoint
      b = { ...FILL, opacity: p < 0.5 ? 0 : (p - 0.5) * 2 };
      overlay = { ...FILL, background: color, opacity: colorAmt };
      break;
    }
    // ── Creator pack approximations (thumbnail only; the real render uses the GPU engine) ──
    case "punchZoom": {
      const scaleB = 1.5 - 0.5 * e;
      a.transform = `scale(${(1 + 0.5 * e).toFixed(3)})`;
      b = { ...FILL, transform: `scale(${scaleB.toFixed(3)})`, opacity: Math.min(1, Math.max(0, (p - 0.4) / 0.2)) };
      break;
    }
    case "zoomBlur": {
      const scaleB = 1.25 - 0.25 * e;
      b = { ...FILL, transform: `scale(${scaleB.toFixed(3)})`, opacity: e, filter: `blur(${((1 - e) * 6).toFixed(1)}px)` };
      break;
    }
    case "whipPan": {
      const off = edgeOffset(direction, 1 - e);
      const vel = Math.sin(p * Math.PI);
      b = { ...FILL, transform: `translate(${off.x}%, ${off.y}%)`, filter: `blur(${(vel * 6).toFixed(1)}px)` };
      a.filter = `blur(${(vel * 6).toFixed(1)}px)`;
      break;
    }
    case "blurSwipe": {
      const vel = Math.sin(p * Math.PI);
      b = { ...FILL, clipPath: wipeInset(direction, e), filter: `blur(${(vel * 5).toFixed(1)}px)` };
      break;
    }
    case "flash": {
      const amt = Math.pow(Math.max(0, 1 - Math.abs(p - 0.5) * 2), 1.5);
      b = { ...FILL, opacity: Math.max(0, Math.min(1, (p - 0.35) / 0.3)) };
      overlay = { ...FILL, background: params.color ?? "#FFFFFF", opacity: amt };
      break;
    }
    case "shake": {
      const env = Math.max(0, 1 - Math.abs(p - 0.5) * 2) * 6;
      const jx = Math.sin(p * 90) * env;
      const jy = Math.cos(p * 78) * env;
      b = { ...FILL, opacity: Math.max(0, Math.min(1, (p - 0.45) / 0.1)), transform: `translate(${jx.toFixed(1)}px, ${jy.toFixed(1)}px)` };
      a.transform = `translate(${jx.toFixed(1)}px, ${jy.toFixed(1)}px)`;
      break;
    }
    case "spin": {
      const ang = (1 - e) * 180;
      const scale = 1 + (1 - e) * 0.4;
      b = { ...FILL, transform: `rotate(${ang.toFixed(1)}deg) scale(${scale.toFixed(3)})`, opacity: Math.min(1, e * 1.4) };
      break;
    }
    case "glitch": {
      const env = Math.max(0, 1 - Math.abs(p - 0.5) * 2);
      const jx = (Math.sin(p * 50) - 0.5) * env * 8;
      b = { ...FILL, opacity: e, transform: `translate(${jx.toFixed(1)}px, 0)`, filter: `hue-rotate(${(env * 40).toFixed(0)}deg) saturate(${1 + env})` };
      break;
    }
    case "parallaxPush": {
      const inOff = edgeOffset(direction, 1 - e);
      const outOff = edgeOffset(direction, -e * 0.6);
      b = { ...FILL, transform: `translate(${inOff.x}%, ${inOff.y}%) scale(${(1 + 0.15 * (1 - e)).toFixed(3)})` };
      a.transform = `translate(${outOff.x}%, ${outOff.y}%) scale(${(1 - 0.15 * e).toFixed(3)})`;
      break;
    }
    case "lightLeak": {
      const amt = Math.max(0, 1 - Math.abs(p - 0.5) * 2);
      b = { ...FILL, opacity: e };
      overlay = { ...FILL, background: "linear-gradient(120deg, rgba(255,150,50,0) 30%, rgba(255,170,80,0.9) 50%, rgba(255,150,50,0) 70%)", opacity: amt };
      break;
    }
    case "filmBurn": {
      const amt = Math.max(0, 1 - Math.abs(p - 0.5) * 2);
      b = { ...FILL, opacity: e };
      overlay = { ...FILL, background: "radial-gradient(circle, rgba(255,120,20,0.95), rgba(120,30,0,0.2))", opacity: amt };
      break;
    }
    case "lumaFade":
    case "pixelate":
      b = { ...FILL, opacity: e };
      break;
    case "maskReveal": {
      const radius = e * 82;
      b = { ...FILL, clipPath: `circle(${radius.toFixed(1)}% at 50% 50%)` };
      break;
    }
    default:
      b = { ...FILL, opacity: e };
  }

  return { a, b, overlay };
}
