/**
 * Is a Flarex comp proxy safe to SUBSTITUTE at playback? (plans/flarex-comp-proxy.md, S2)
 *
 * Kept in its own module with NO imports beyond a type: the rule is a pure timeline query, and the
 * rest of the proxy code reaches into the export/WebCodecs stack, which cannot be loaded outside a
 * browser. Splitting it is what lets the rule have a real test.
 */

import type { TimelineLayer } from "@orreris/shared";

/**
 * Whether this host clip's proxy can stand in for the live graph without changing compositing.
 *
 * The renderers flood `composition.backgroundColor` under every frame, so a rendered proxy is always
 * OPAQUE. That is correct for the timeline span proxy, which stands in for the whole frame. A comp
 * proxy replaces ONE layer's draw at its z-slot, so any comp output with transparency — a keyer, a
 * merge over nothing, a transform that does not fill frame — would come back as an opaque rectangle
 * and paint the composition background over everything beneath it.
 *
 * The provably safe case is the one where the baked background IS what would have been behind the
 * clip: nothing is drawn below it at any instant of its span. Then opaque is right by construction,
 * with no need to know anything about the node graph.
 *
 * `zOrderedLayers` must be the same BACK-TO-FRONT list the draw builder consumes, so "below" means
 * "earlier in the array". Audio has no picture and is ignored.
 *
 * Deliberately narrow — it excludes stacked comps, which is often where heavy graphs live. Widening
 * it means encoding real alpha (`VideoEncoderConfig.alpha: "keep"`, VP8/VP9 only, no H.264) and
 * decoding it back, which is its own slice. Until then a stacked comp keeps evaluating live, which is
 * today's behavior and so can never be a regression.
 */
export function canSubstituteFlarexProxy(zOrderedLayers: readonly TimelineLayer[], host: TimelineLayer): boolean {
  const hostEnd = host.startSeconds + host.durationSeconds;
  for (const layer of zOrderedLayers) {
    if (layer.id === host.id) return true; // reached the host with nothing visual below it
    if (layer.type === "audio") continue;
    const end = layer.startSeconds + layer.durationSeconds;
    // A visual layer BELOW the host sharing even an instant of its span would be occluded by the
    // proxy's baked background. Half-open overlap, which also reports a DEGENERATE zero-length layer
    // as overlapping — deliberately kept, because refusing costs one missed optimization while
    // admitting wrongly paints over everything below. Pinned by the gate.
    if (layer.startSeconds < hostEnd && host.startSeconds < end) return false;
  }
  // Host not in the list at all — unknown z-position, so refuse. Every failure mode here must fall
  // back to live evaluation.
  return false;
}
