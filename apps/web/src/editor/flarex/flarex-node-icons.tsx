/**
 * Custom node glyphs for the Flarex palette + canvas.
 *
 * One hand-drawn 16×16 line icon per `FlarexNodeType`, so the toolbar reads as a Fusion-style icon
 * strip instead of a wall of text (which clutters fast as the palette grows). Every glyph strokes
 * with `currentColor` at a shared 1.4 weight, so it inherits the button's muted/hover/active color
 * states and the group accent stays on the button's left strip. Keep them geometric and legible at
 * 16px — no fills except where a solid mark reads clearer (dots, the reroute node).
 */

import type { ReactElement } from "react";
import type { FlarexNodeType } from "@orreris/shared";

export interface FlarexIconProps {
  size?: number;
  className?: string;
}

const base = (size: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className,
  "aria-hidden": true,
});

/** Path/element bodies keyed by node type. Rendered inside a shared <svg> shell. */
const GLYPHS: Record<FlarexNodeType, ReactElement> = {
  // ── IO ───────────────────────────────────────────────────────────────────
  mediaIn: (
    <>
      <rect x="6.5" y="2.5" width="7" height="11" rx="1" />
      <path d="M2 8h5m0 0L5 6m2 2L5 10" />
    </>
  ),
  mediaOut: (
    <>
      <rect x="2.5" y="2.5" width="7" height="11" rx="1" />
      <path d="M9 8h5m0 0-2-2m2 2-2 2" />
    </>
  ),

  // ── Composite ────────────────────────────────────────────────────────────
  merge: (
    <>
      <circle cx="6" cy="8" r="4" />
      <circle cx="10" cy="8" r="4" />
    </>
  ),
  transform: (
    <>
      <rect x="3.5" y="3.5" width="9" height="9" rx="0.5" />
      <path d="M3.5 3.5h1.5M3.5 3.5v1.5M12.5 3.5h-1.5M12.5 3.5v1.5M3.5 12.5h1.5M3.5 12.5v-1.5M12.5 12.5h-1.5M12.5 12.5v-1.5" />
    </>
  ),

  // Crop marks around a kept region.
  crop: (
    <>
      <path d="M5 1.8v9.4a1 1 0 0 0 1 1h8.2" />
      <path d="M1.8 4.8h8.2a1 1 0 0 1 1 1v8.4" />
    </>
  ),
  // Three channel bars re-routed into one output.
  channelBoolean: (
    <>
      <path d="M2.4 4h4M2.4 8h4M2.4 12h4" />
      <path d="M6.4 4h2l3 4h2.2M6.4 8h5.2M6.4 12h2l3-4" />
      <circle cx="13.4" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),

  // ── Color ────────────────────────────────────────────────────────────────
  // The unified grade node: a trackball with a tone curve through it — the two halves of the toolset
  // it carries, and distinct from `colorWheels` (three balls) and `colorCurves` (a framed curve).
  color: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M3.6 11.6C6 11.6 6.6 4.4 12.4 4.4" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  colorCorrect: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor" stroke="none" />
    </>
  ),
  colorCurves: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M3.5 12.5C6 12.5 6 3.5 12.5 3.5" />
    </>
  ),
  hueSat: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="10.5" cy="6.2" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  // Three trackballs in a row (lift / gamma / gain) — reads as the wheels panel, not another disc.
  colorWheels: (
    <>
      <circle cx="3.4" cy="8" r="2.6" />
      <circle cx="8" cy="8" r="2.6" />
      <circle cx="12.6" cy="8" r="2.6" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  // A hue wheel with one wedge ISOLATED — the qualifier picks a slice of colour, not the whole image.
  hslQualifier: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 8 13.2 5.9A5.5 5.5 0 0 1 13.2 10.1Z" fill="currentColor" stroke="none" />
      <path d="M8 8 13.2 5.9M8 8 13.2 10.1" />
    </>
  ),
  // An isometric cube — the 3D LUT itself.
  lut: (
    <>
      <path d="M8 2.2 13.6 5.1v5.8L8 13.8 2.4 10.9V5.1z" />
      <path d="M2.4 5.1 8 8m0 0 5.6-2.9M8 8v5.8" opacity="0.75" />
    </>
  ),
  // A framed swatch split light/dark — a graded look applied to a frame.
  look: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M8 3v10h4.5a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z" fill="currentColor" stroke="none" opacity="0.85" />
    </>
  ),

  // A frame with darkened corners.
  vignette: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 4.5a3.6 3.6 0 0 0 2.6 2.6 3.6 3.6 0 0 0-2.6 2.6z" fill="currentColor" stroke="none" opacity="0.8" />
      <path d="M13.5 4.5a3.6 3.6 0 0 1-2.6 2.6 3.6 3.6 0 0 1 2.6 2.6z" fill="currentColor" stroke="none" opacity="0.8" />
    </>
  ),
  // Scattered film-grain speckle.
  grain: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M5 5.5h.01M8.2 4.8h.01M11.3 6h.01M4.6 8.4h.01M7.4 7.9h.01M10.4 9h.01M5.6 11h.01M9 11.3h.01M12 11h.01" strokeWidth="1.6" />
    </>
  ),

  // ── Filter ───────────────────────────────────────────────────────────────
  blur: (
    <>
      <circle cx="8" cy="8" r="2.4" />
      <circle cx="8" cy="8" r="5.4" strokeDasharray="1.6 2" opacity="0.7" />
    </>
  ),
  // Motion streaks along one axis.
  directionalBlur: (
    <>
      <path d="M2.5 5h11M2.5 8h8M2.5 11h11" />
      <path d="M11.5 8h2" opacity="0.45" />
    </>
  ),
  // Streaks radiating from a centre point.
  radialBlur: (
    <>
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <path d="M8 4.2V1.8M8 11.8v2.4M4.2 8H1.8M11.8 8h2.4M5.3 5.3 3.6 3.6M10.7 10.7l1.7 1.7M10.7 5.3l1.7-1.7M5.3 10.7 3.6 12.4" />
    </>
  ),
  glow: (
    <>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
    </>
  ),
  sharpen: (
    <>
      <path d="M8 2.5 13.5 13.5H2.5z" />
      <path d="M8 6v4.5" opacity="0.7" />
    </>
  ),
  // A coarse mosaic grid.
  pixelate: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11" opacity="0.7" />
      <rect x="6.2" y="6.2" width="3.6" height="3.6" fill="currentColor" stroke="none" opacity="0.85" />
    </>
  ),
  // A prism splitting a beam into fringes.
  prism: (
    <>
      <path d="M8 2.6 13.6 12.4H2.4z" />
      <path d="M9.6 8.2h4.4M9.6 10h4.4" opacity="0.6" />
    </>
  ),
  filter: <path d="M2.5 3.5h11l-4 5v4l-3 1.5V8.5z" />,

  // ── Key / Mask ───────────────────────────────────────────────────────────
  // Eyedropper picking the key colour (was an arrow-to-corner that read as "external link").
  chromaKey: (
    <>
      <path d="M13.4 2.6a1.6 1.6 0 0 0-2.2 0l-1 1 2.2 2.2 1-1a1.6 1.6 0 0 0 0-2.2Z" fill="currentColor" stroke="none" />
      <path d="M10.2 4.4 3.7 10.9v1.4h1.4l6.5-6.5" />
    </>
  ),
  lumaKey: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M13.5 2.5 2.5 13.5H2.5V2.5z" fill="currentColor" stroke="none" opacity="0.85" />
    </>
  ),
  rectMask: <rect x="2.5" y="4" width="11" height="8" rx="1" />,
  ellipseMask: <ellipse cx="8" cy="8" rx="5.5" ry="4.5" />,
  polygonMask: <path d="M8 2.5 13.5 7l-2.1 6.5H4.6L2.5 7z" />,
  bezierMask: (
    <>
      <path d="M3 12C3 6 13 10 13 4" />
      <circle cx="3" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="4" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  // A framed soft matte (feathered alpha) — was two overlapping circles, a near-duplicate of `merge`.
  matteControl: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" opacity="0.85" />
      <circle cx="8" cy="8" r="4.4" strokeDasharray="1.4 1.7" opacity="0.6" />
    </>
  ),

  // ── Generator ────────────────────────────────────────────────────────────
  text: <path d="M3.5 4h9M3.5 4V6M12.5 4V6M8 4v9M6.2 13h3.6" />,
  // A filled plate — the solid a comp is built on top of.
  background: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1" fill="currentColor" stroke="none" opacity="0.55" />
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
    </>
  ),

  // ── AI / tracking ────────────────────────────────────────────────────────
  aiMatte: (
    <>
      <path d="M5 13.5c0-2 1.3-3.2 3-3.2s3 1.2 3 3.2" />
      <circle cx="8" cy="6" r="2.2" />
      <path d="M12.5 2 13 3.2 14.2 3.7 13 4.2 12.5 5.4 12 4.2 10.8 3.7 12 3.2z" fill="currentColor" stroke="none" />
    </>
  ),
  tracker: (
    <>
      <rect x="4.5" y="4.5" width="7" height="7" rx="0.5" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </>
  ),

  // A clock face with a fast-forward chevron — retime, not playback.
  timeSpeed: (
    <>
      <circle cx="6.5" cy="8" r="5" />
      <path d="M6.5 5v3l2 1.4" />
      <path d="M11.5 5.5L14.5 8l-3 2.5" />
    </>
  ),

  // ── Layout ───────────────────────────────────────────────────────────────
  backdrop: <rect x="2.5" y="2.5" width="11" height="11" rx="1" strokeDasharray="2 1.6" />,
  // A container framing two nodes — the collapse-a-selection block.
  group: (
    <>
      <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.4" strokeDasharray="2.4 1.8" />
      <rect x="4" y="6" width="3.4" height="4" rx="0.6" />
      <rect x="8.6" y="6" width="3.4" height="4" rx="0.6" />
    </>
  ),
  reroute: (
    <>
      <path d="M2.5 8h11" opacity="0.6" />
      <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
    </>
  ),
};

/** The one glyph for a node type, rendered in the shared 16×16 stroke shell. */
export function FlarexNodeIcon({ type, size = 15, className }: FlarexIconProps & { type: FlarexNodeType }) {
  return (
    <svg {...base(size, className)}>
      {GLYPHS[type]}
    </svg>
  );
}
