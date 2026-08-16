/**
 * ADR-023 D8 (S8) — text on a path, the ONE thing in this stage that genuinely needs a second
 * rendering surface.
 *
 * D8 named two: concentric multi-strokes and path text. The first turned out not to need SVG at all
 * — both surfaces that ship a picture do concentric strokes natively, measured band for band in
 * `apps/worker/tmp/s8-premise-probe.mjs`, and that half now ships as ordinary `strokeText` passes and
 * a stacked DOM copy. This half is the real one: canvas 2D has no text-on-a-path, and the honest
 * ways to fake it all break the shaping run.
 *
 * **SVG is a second SURFACE, not a second TEXT ENGINE, and that distinction is the whole reason this
 * is allowed under D6/T-5.** `<textPath>` hands the string to the same shaper `fillText` uses: it
 * shapes the run first and places the resulting glyphs along the geometry, which is why an Arabic run
 * on a straight path measures 91.64px against flat text's 91.63px while the isolated-glyph sum is
 * 110.88px (same probe, arm D). The alternative — measuring per cluster in canvas and rotating each
 * one onto the arc — would have been a second engine doing glyph lookup instead of shaping, which is
 * exactly the `font-outlines.ts` mistake D9a spent a stage deleting.
 *
 * **The isolated-document problem, and why fonts travel INSIDE the SVG.** The raster gets these
 * pixels by drawing the SVG as an `<img>`, and such a document cannot fetch anything — not the
 * parent page's `@font-face` rules, not an HTTP URL, nothing. A pinned face therefore has to be
 * embedded as a data URI in the document itself, which the same probe's arm F proves works (two
 * different pinned faces render two different pictures; two faces that both failed to load would
 * collapse onto one fallback, which is the only way that arm can fail honestly).
 *
 * **And when it cannot be embedded, this refuses to draw.** A pinned font with no bytes to embed
 * would render in a system fallback — a silent substitution, which is the warp-catalogue incident
 * (§1) and precisely what D3/T-2 exist to prevent. `buildArcTextSvg` returns `undefined` in that
 * case and the caller falls back to ordinary straight text, which is visibly not what was asked for
 * rather than invisibly the wrong typeface.
 */
import { hasTextPathCurve, parseTextStroke } from "../composition-style";

export { hasTextPathCurve };

/** What path mode can express. Deliberately a SUBSET — see `textPathUnsupported` below. */
export interface ArcTextSpec {
  text: string;
  /** -100..100. Sign is the bend direction; magnitude is how much of a half-circle the run wraps. */
  curve: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number | string;
  fontStyle: string;
  letterSpacing: number;
  /** Natural width of the run when drawn straight — the arc is built to have this arc LENGTH, so the
   *  glyphs neither bunch up nor stretch as the curve changes. Measured by the caller, which is the
   *  only party holding a context with the right font on it. */
  textWidth: number;
  /**
   * The face's OWN ascent and descent above/below the baseline, measured by the caller with
   * `measureText`. Not approximated as fractions of the font size: the arc's ink box is what centres
   * the run in its raster, so a guess here means the text JUMPS the moment a user drags the curve
   * off zero — the one thing a curve control must not do.
   */
  ascent: number;
  descent: number;
  fill: string;
  /** The S5 two-stop gradient, already resolved. */
  gradient?: { from: string; to: string; angleDeg: number } | undefined;
  /** `"<w>px <color>"`, the emitted idiom, inner ring then outer ring. */
  stroke?: string | undefined;
  outerStroke?: string | undefined;
  strokeUnderFill: boolean;
  direction?: "ltr" | "rtl" | undefined;
  /**
   * `@font-face` rules to embed, or `undefined` when the layer's font needs no embedding (a system
   * family resolves by name inside the image). An EMPTY string is the third state and means "this
   * layer pins a font whose bytes we could not get", which is a refusal, not an empty rule set.
   */
  fontFaceCss?: string | undefined;
}

/** At |curve| = 100 the run wraps a half circle. */
const MAX_SWEEP_RADIANS = Math.PI;

/** The arc's geometry, in the caller's own units. Exported so the overhang margin and the SVG agree. */
export function arcGeometry(curve: number, textWidth: number): { radius: number; sweep: number; sagitta: number; up: boolean } {
  const sweep = (MAX_SWEEP_RADIANS * Math.min(100, Math.abs(curve))) / 100;
  const radius = textWidth / sweep;
  return { radius, sweep, sagitta: radius * (1 - Math.cos(sweep / 2)), up: curve > 0 };
}

/**
 * How far the arc reaches beyond the straight text's own box, so the caller can size a raster that
 * does not clip it. The same shape as `warpOverhang` and for the same reason.
 */
export function textPathOverhang(curve: number, textWidth: number, fontSize: number): number {
  if (!hasTextPathCurve(curve)) return 0;
  const { sagitta, radius, sweep } = arcGeometry(curve, textWidth);
  // Vertically the run reaches the sagitta plus a line of glyphs; horizontally a wrapped arc is
  // NARROWER than the straight run, never wider, so the vertical term bounds both.
  const horizontal = Math.max(0, radius * Math.sin(Math.min(sweep, Math.PI) / 2) * 2 - textWidth);
  return Math.ceil(Math.max(sagitta + fontSize, horizontal) + 4);
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Build the SVG document for one arc-text run, sized `width` x `height` with the arc centred in it.
 *
 * Returns `undefined` when the layer pins a font whose bytes could not be embedded — see the header:
 * drawing it anyway would be a silent substitution.
 */
export function buildArcTextSvg(spec: ArcTextSpec, width: number, height: number): string | undefined {
  if (spec.fontFaceCss === "") return undefined;
  if (!spec.text || spec.textWidth <= 0) return undefined;

  const { radius, sweep, sagitta, up } = arcGeometry(spec.curve, spec.textWidth);
  const { ascent, descent } = spec;
  const inkHeight = sagitta + ascent + descent;
  // The arc's extreme point (top of a rainbow, bottom of a valley) sits here; the ink box is then
  // centred in the canvas so the caller's own centring and this one agree.
  const yMid = up ? (height - inkHeight) / 2 + ascent : (height - inkHeight) / 2 + ascent + sagitta;
  const cx = width / 2;
  const cy = up ? yMid + radius : yMid - radius;
  const dx = radius * Math.sin(sweep / 2);
  const dy = radius * Math.cos(sweep / 2);
  const [x0, y0, x1, y1] = up ? [cx - dx, cy - dy, cx + dx, cy - dy] : [cx - dx, cy + dy, cx + dx, cy + dy];
  const largeArc = sweep > Math.PI ? 1 : 0;
  // Left → over the top → right is CLOCKWISE in SVG's y-down space (sweep-flag 1); a valley is the
  // same traversal counter-clockwise.
  const sweepFlag = up ? 1 : 0;
  const n = (v: number) => Math.round(v * 1000) / 1000;
  const d = `M ${n(x0)} ${n(y0)} A ${n(radius)} ${n(radius)} 0 ${largeArc} ${sweepFlag} ${n(x1)} ${n(y1)}`;

  const inner = spec.stroke ? parseTextStroke(spec.stroke) : undefined;
  const outer = spec.outerStroke ? parseTextStroke(spec.outerStroke) : undefined;

  const fontAttrs =
    `font-family="${esc(spec.fontFamily)}" font-size="${n(spec.fontSize)}" font-weight="${esc(String(spec.fontWeight))}" ` +
    `font-style="${esc(spec.fontStyle)}"` +
    (spec.letterSpacing ? ` letter-spacing="${n(spec.letterSpacing)}"` : "") +
    (spec.direction ? ` direction="${spec.direction}"` : "");
  // `startOffset` 50% with `text-anchor: middle` centres the run on the arc. The arc was built to the
  // run's own length, so this is a centring, not a fit.
  const body = `<textPath href="#arc" startOffset="50%">${esc(spec.text)}</textPath>`;
  const textEl = (extra: string) => `<text ${fontAttrs} text-anchor="middle" ${extra}>${body}</text>`;

  /**
   * The strokes, as their own `<text>` elements drawn widest first — the identical construction the
   * canvas raster uses, for the identical reason (a narrower ring covers the inner half of a wider
   * one). SVG's `paint-order` could put ONE stroke behind one fill, but it cannot express two rings,
   * so the rings are separate elements here even when the layer paints stroke-under.
   */
  const rings: string[] = [];
  if (outer) rings.push(textEl(`fill="none" stroke="${esc(outer.color)}" stroke-width="${n(outer.width)}" stroke-linejoin="round"`));
  if (inner) rings.push(textEl(`fill="none" stroke="${esc(inner.color)}" stroke-width="${n(inner.width)}" stroke-linejoin="round"`));

  const gradientDef = spec.gradient
    ? (() => {
        // CSS gradient angles are clockwise from "up"; SVG's x1/y1→x2/y2 vector is plain geometry.
        const rad = ((spec.gradient!.angleDeg - 90) * Math.PI) / 180;
        const ux = Math.cos(rad);
        const uy = Math.sin(rad);
        return (
          `<linearGradient id="g" x1="${n(0.5 - ux / 2)}" y1="${n(0.5 - uy / 2)}" x2="${n(0.5 + ux / 2)}" y2="${n(0.5 + uy / 2)}">` +
          `<stop offset="0" stop-color="${esc(spec.gradient!.from)}"/><stop offset="1" stop-color="${esc(spec.gradient!.to)}"/>` +
          `</linearGradient>`
        );
      })()
    : "";
  const fillEl = textEl(`fill="${spec.gradient ? "url(#g)" : esc(spec.fill)}"`);

  // Stroke-under is the rings then the fill; stroke-over is the fill then the rings. Same rule the
  // raster follows, read off the same resolved flag.
  const painted = spec.strokeUnderFill ? [...rings, fillEl] : [fillEl, ...rings];

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">` +
    `<defs>${spec.fontFaceCss ? `<style>${spec.fontFaceCss}</style>` : ""}${gradientDef}` +
    `<path id="arc" d="${d}" fill="none"/></defs>` +
    painted.join("") +
    `</svg>`
  );
}

/**
 * Style properties that have NO meaning on a path, declared rather than silently dropped — the
 * plan's own instruction for this stage ("or an explicit 'not available in path mode'").
 *
 * Each is a real decision, not a gap:
 *
 * - **per-line pill / block background** — a path has no line boxes to put a background behind, and
 *   a single pill around a curved run would be a rectangle around a rainbow.
 * - **image texture fill** — an SVG `<pattern>` from a data URI is buildable, but the image would
 *   have to be embedded in the isolated document too, and no product ask pairs a photo fill with a
 *   curve. Straight text keeps it.
 * - **text shadow / the S5 stack** — `feDropShadow` gives one, and N stacked copies of a filtered
 *   element is a different construction from N `text-shadow` entries. Approximating it would put the
 *   two surfaces visibly out of step, which is the thing this stage is most careful about.
 * - **multi-line text** — a path is one run. Newlines are joined with a space rather than silently
 *   truncating the layer's text to its first line.
 * - **warp** — deforming a picture that was placed along a path composes two geometries with no
 *   agreed order. Warp shipped first, so warp wins and the curve is ignored.
 */
export const textPathUnsupported = [
  "backgroundColor",
  "backgroundPerLine",
  "fillTexture",
  "textShadow",
  "multiline",
  "textWarp"
] as const;
