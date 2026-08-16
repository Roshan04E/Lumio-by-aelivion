/**
 * ADR-023 S9 — per-character animation, the MODEL half.
 *
 * Everything in this file is pure arithmetic over a resolved animation and a cluster count. The
 * PAINT half lives in `scene/text-shape.ts`, which is the only place that owns a canvas, and it takes
 * its band geometry from {@link tileSpans} here so the tiling invariant can be asserted in
 * milliseconds without a browser.
 *
 * ## WHAT A "CHARACTER" IS, AND WHY IT IS NOT NEGOTIABLE (OQ6, answered)
 *
 * A grapheme CLUSTER, from `Intl.Segmenter`. Never a code unit and never a code point. `[...s]` — the
 * split a naive implementation reaches for — separates a combining mark from its base, splits an
 * emoji ZWJ family into five people, and cuts a Devanagari conjunct in half. The spike measured all
 * three (`apps/worker/tmp/oq6-spike.mjs`): 2 code points → 1 cluster, 5 → 1, and a conjunct that a
 * code-point split reports as three "characters".
 *
 * If `Intl.Segmenter` is missing the animation is REFUSED, not approximated down to code points. A
 * per-code-point reveal is not a slightly worse version of this feature; it is the defect the
 * question was asked to avoid, shipped under the feature's name.
 *
 * ## WHY THIS FILE HAS NO SHAPING IN IT AT ALL
 *
 * The other half of OQ6 is that a per-cluster TRANSFORM breaks the shaping run — each animated
 * cluster becomes its own shaping context. The answer (T-14) is to shape and rasterize the run ONCE
 * and then SLICE the finished raster, so shaping happens strictly before anything moves and moving
 * cannot re-open it. That is why this module knows about clusters and spans and nothing about fonts:
 * by the time a span is applied, the glyphs are already pixels.
 *
 * The slice needs per-cluster BANDS, and canvas 2D exposes no per-glyph positions, so the only source
 * of band edges is prefix `measureText`. On a cursive script that source is provably wrong — the
 * spike measured 2 of 13 Arabic prefix widths going BACKWARDS, because each prefix shapes in
 * isolation and a prefix ending mid-word takes a FINAL form where the run gives a MEDIAL one. So a
 * shaping-dependent script is DISABLED, visibly, per T-12's discipline, and `detectTextScript` is the
 * instrument that decides — the third consumer the S0 amendment predicted.
 */

import { detectTextScript } from "./text-script";

/** A layer's declared per-cluster animation, resolved at a time. See {@link resolveTextClusterAnimation}. */
export interface TextClusterAnimation {
  /**
   * 0 → nothing has arrived, 1 → everything has. Keyframable (`style.clusterRevealProgress`), which
   * is what makes this a reveal rather than a static offset; the keyframe evaluator is the existing
   * one, per S9's scope note that this stage adds no animation system.
   */
  progress: number;
  /** How far below its resting place a cluster starts, in em of the layer's font size. May be 0 (a pure fade). */
  riseEm: number;
  /** 0 → every cluster moves together; →1 → each waits for the one before it. See {@link clusterPhase}. */
  staggerFraction: number;
}

/** The three fields as they arrive on a layer or in a manifest style bag — any subset, all optional. */
export interface TextClusterAnimationSource {
  clusterRevealProgress?: number | undefined;
  clusterRiseEm?: number | undefined;
  clusterStaggerFraction?: number | undefined;
}

/**
 * DECLARED — the layer asked for a per-cluster animation at all.
 *
 * D1a, and it is the reason this is a separate question from "is anything moving": absent is not
 * `progress: 1`. A layer that never named any of the three fields must emit no animation key, so its
 * raster cache key and its emitted style are byte-identical to what they were before this stage
 * existed, permanently. A layer that named `clusterRiseEm` and nothing else HAS an animation — one
 * sitting at rest — and says so.
 */
export function hasTextClusterAnimationSource(source: TextClusterAnimationSource): boolean {
  return (
    isRealNumber(source.clusterRevealProgress) ||
    isRealNumber(source.clusterRiseEm) ||
    isRealNumber(source.clusterStaggerFraction)
  );
}

function isRealNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The three fields → the resolved animation, or `undefined` when the layer declared none.
 *
 * `progress` is NOT clamped to a maximum here beyond 1 because {@link isTextClusterAnimationAtRest}
 * reads it: a value at or over 1 is rest, and rest is the state that has to be indistinguishable from
 * absence in the picture.
 */
export function resolveTextClusterAnimation(source: TextClusterAnimationSource): TextClusterAnimation | undefined {
  if (!hasTextClusterAnimationSource(source)) return undefined;
  return {
    progress: isRealNumber(source.clusterRevealProgress) ? source.clusterRevealProgress : 1,
    riseEm: isRealNumber(source.clusterRiseEm) ? source.clusterRiseEm : 0,
    staggerFraction: isRealNumber(source.clusterStaggerFraction) ? clamp01(source.clusterStaggerFraction) : 0
  };
}

/**
 * AT REST — every cluster has arrived, so the animation contributes nothing (P4).
 *
 * This is the gate the whole slice path hangs off, and the reason P4 is byte-identical rather than
 * merely close: at rest the paint path does not slice at all, it takes the ordinary draw. Not an
 * optimisation dressed up as a rule — an animation that has finished IS the unanimated picture, and
 * any route that reproduced it through a resample would make "settled" and "absent" two different
 * pictures. The tiling equality that the slice route owes is asserted separately and directly
 * (`text:s9-slice-tiling`), because a bypass cannot be evidence for the thing it bypasses.
 */
export function isTextClusterAnimationAtRest(animation: TextClusterAnimation): boolean {
  return animation.progress >= 1;
}

/**
 * Split into grapheme clusters, or `undefined` if this runtime cannot — see the header: a missing
 * `Intl.Segmenter` REFUSES rather than falling back to code points.
 */
export function segmentGraphemes(text: string): string[] | undefined {
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string }> } })
    .Segmenter;
  if (typeof Segmenter !== "function") return undefined;
  const out: string[] = [];
  for (const piece of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) out.push(piece.segment);
  return out;
}

/** Why a layer that declared an animation is not getting one. Each is a REFUSAL with a picture. */
export type TextClusterAnimationRefusal = "script" | "curve" | "segmenter";

/**
 * Can this layer's declared animation actually run? `undefined` = yes.
 *
 * Read by the paint path AND by the editor, so what the inspector says and what the renderer does
 * cannot disagree — the T-12 discipline, which exists because the incident it was written for was a
 * wrong render nobody could see was wrong.
 *
 * WARP IS DELIBERATELY NOT HERE. Warp does not refuse this animation; it COMPOSES with it, and the
 * composition has a declared order (P1: the animation runs first, warp deforms the already-animated
 * picture). That order is enforced by control flow in `drawTextLayer` — warp's inner draw is an
 * ordinary draw, which is where the slice happens — not by a rule in this function.
 */
export function textClusterAnimationRefusal(
  text: string,
  options: { pathCurveActive: boolean }
): TextClusterAnimationRefusal | undefined {
  // The curve WINS (P2). A curved run is one finished picture handed back by the SVG surface, with no
  // per-glyph positions along the arc that anything exposes — there is nothing to slice, and slicing
  // it on measured-straight bands would displace ink that is not where the bands think it is.
  if (options.pathCurveActive) return "curve";
  // A shaping-dependent script WINS (P3, T-14). Measured, not assumed — see the header.
  if (detectTextScript(text).shapingDependent) return "script";
  if (!segmentGraphemes("a")) return "segmenter";
  return undefined;
}

/**
 * One cluster's state: how far along it is, and therefore where it sits and how solid it is.
 *
 * THE STAGGER MODEL. `staggerFraction` is the share of the whole reveal spent handing off between
 * clusters; `1 - staggerFraction` is the share any single cluster spends travelling. At 0 every
 * cluster runs the full window together; at 0.6 the last cluster starts when the reveal is 60% done
 * and has the remaining 40% to arrive. It is a FRACTION rather than a per-cluster delay in seconds
 * so that the reveal takes the same wall time whether the word has four clusters or forty — a delay
 * in seconds makes a long title run off the end of its own layer.
 *
 * `easeOutCubic` on the per-cluster window: a reveal decelerates into place. Written out rather than
 * routed through the keyframe evaluator's easing table because this is the shape WITHIN one cluster's
 * window, not the shape of the property over time — the property's own curve is whatever the user
 * keyframed onto `clusterRevealProgress`, and the two compose.
 */
export function clusterPhase(index: number, count: number, animation: TextClusterAnimation): {
  eased: number;
  /** Vertical offset in em, positive = still BELOW its resting place. 0 once arrived. */
  offsetEm: number;
  alpha: number;
} {
  const stagger = clamp01(animation.staggerFraction);
  const start = count > 1 ? (index / (count - 1)) * stagger : 0;
  // A stagger of exactly 1 would give every cluster a zero-length window; the floor keeps the last
  // cluster's arrival a step function rather than a division by zero.
  const span = Math.max(1e-6, 1 - stagger);
  const local = clamp01((animation.progress - start) / span);
  const eased = 1 - Math.pow(1 - local, 3);
  return { eased, offsetEm: animation.riseEm * (1 - eased), alpha: eased };
}

/**
 * The largest offset any cluster can be at, in em — what the raster has to leave room for below the
 * text box so a rising cluster is not clipped by the box it is rising into.
 *
 * ZERO AT REST, and that is load-bearing rather than tidy. The margin feeds the tight-box raster's
 * canvas size, so a margin that stayed non-zero at rest would make a settled animation rasterize into
 * a DIFFERENT-SIZED canvas than an unanimated layer, and P4's byte-identity would fail on the padding
 * rather than on anything anyone animated.
 */
export function textClusterAnimationOverhangEm(animation: TextClusterAnimation): number {
  if (isTextClusterAnimationAtRest(animation)) return 0;
  return Math.abs(animation.riseEm);
}

/**
 * Cluster start offsets → spans that TILE `[lo, hi]` exactly: no gaps, no overlaps, first span starts
 * at `lo`, last ends at `hi`.
 *
 * THE TILING IS THE ACCEPTANCE BAR FOR THE SLICE ITSELF, before any animation is applied. At zero
 * displacement every span is a pixel-exact `drawImage` of the source's own band back onto itself, so
 * the reassembled picture is the source byte for byte — a memcpy, with no second rasterization to
 * disagree with the first. A gap drops a column of pixels; an overlap composites a column twice,
 * which for antialiased glyph edges is visibly darker. Both are silent.
 *
 * The ends are extended to `lo`/`hi` rather than to the run's own advance width because a glyph's ink
 * reaches OUTSIDE its advance — side bearings, italic overhang, a shadow — and ink outside every span
 * would simply be dropped.
 */
export function tileSpans(starts: number[], lo: number, hi: number): Array<{ x0: number; x1: number }> {
  if (!starts.length) return [];
  const spans: Array<{ x0: number; x1: number }> = [];
  for (let i = 0; i < starts.length; i += 1) {
    const x0 = i === 0 ? lo : Math.max(lo, Math.min(hi, starts[i]!));
    const x1 = i === starts.length - 1 ? hi : Math.max(lo, Math.min(hi, starts[i + 1]!));
    spans.push({ x0, x1: Math.max(x0, x1) });
  }
  // Monotonicity repair. On a well-behaved script the starts are already increasing; this exists so a
  // pathological measurement produces an EMPTY span (drawn as nothing) rather than a negative-width
  // one, which `drawImage` would either reject or mirror.
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i]!.x0 < spans[i - 1]!.x1) spans[i]!.x0 = spans[i - 1]!.x1;
    if (spans[i]!.x1 < spans[i]!.x0) spans[i]!.x1 = spans[i]!.x0;
  }
  const last = spans[spans.length - 1]!;
  last.x1 = hi;
  return spans;
}

/**
 * The emitted form: `"<progress> <riseEm> <staggerFraction>"`.
 *
 * Emitted as ONE packed string, the idiom this file's neighbours already use (`textLinePill`,
 * `WebkitTextStroke`, `fillTexture`), and emitted CONDITIONALLY — the key is absent from the style
 * object entirely for a layer that declared no animation. Three separately-emitted keys would have
 * put three `undefined`s into the emitted style of every text layer in every project, which moves
 * `scene-text-raster`'s content cache key and every one of `textstyle:golden`'s 103 recorded objects
 * for a stage that changes no pixels on any of them.
 */
export function textClusterAnimationCss(animation: TextClusterAnimation | undefined): string | undefined {
  return animation ? `${animation.progress} ${animation.riseEm} ${animation.staggerFraction}` : undefined;
}

/** Read `"<progress> <riseEm> <staggerFraction>"` back. One parser, so no renderer writes a second. */
export function parseTextClusterAnimation(value: string): TextClusterAnimation | undefined {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) return undefined;
  const [progress, riseEm, staggerFraction] = parts.map(Number);
  if (!isRealNumber(progress) || !isRealNumber(riseEm) || !isRealNumber(staggerFraction)) return undefined;
  return { progress, riseEm, staggerFraction };
}
