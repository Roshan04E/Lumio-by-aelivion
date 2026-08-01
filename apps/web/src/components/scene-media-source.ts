/**
 * Single-context GPU-first preview (Phase 5, flag `orreris.singleCtxPreview`) — the seam between
 * `WebglMediaLayer` (frame PRODUCER) and `ScenePreviewCanvas` (in-context GRADER).
 *
 * When the flag is on, a scene-composited media layer stops creating its own `MediaWebGLRenderer`
 * context/canvas. Instead it registers ONE stable {@link ScenePreviewMediaSource} descriptor whose
 * `snapshot()` exposes the layer's RAW frame source (the pooled `<video>` element, the held WebCodecs
 * `VideoFrame` clone, the full-res settle frame, or the decoded still bitmap) together with the grade
 * inputs the layer's own shader pass used to bake (`ColorPipeline` / matte / stylize effects / amount /
 * baked opacity). `ScenePreviewCanvas` then uploads the raw frame ONCE and grades it through a
 * shared-context `MediaWebGLRenderer` + `RenderTarget` on the SceneCompositor's own WebGL2 context —
 * the exact single-context architecture the EXPORT path already ships
 * (`SceneFrameCompositor.gradeMediaLayer`, `exportSingleContext`).
 *
 * All fields are read at COMPOSITE time (the compositor calls `snapshot()` per composited frame), so
 * the descriptor must always reflect the layer's live props — implementations read refs, never close
 * over render-time values. `frameVersion` + the keys drive the compositor's re-grade skip: an
 * unchanged key set means the cached graded `RenderTarget` is reused with zero uploads (the static
 * photo win the producer-version upload skip used to provide).
 */

import type { ColorPipeline, MediaEffects, MediaTransition } from "@orreris/shared";

export interface ScenePreviewMediaFrame {
  /** The raw decode source to upload (video element / VideoFrame clone / ImageBitmap / img). */
  source: TexImageSource;
  width: number;
  height: number;
}

export interface ScenePreviewMediaSnapshot {
  /** Current raw frame, or null when nothing is decoded yet (layer draws nothing this frame). */
  frame: ScenePreviewMediaFrame | null;
  /** Monotonic counter, bumped by the layer whenever a NEW frame is published. */
  frameVersion: number;
  pipeline: ColorPipeline | null;
  /** Memoized JSON of `pipeline` (drives the shared renderer's LUT re-bake skip). */
  pipelineKey: string;
  mediaEffects: MediaEffects | null;
  mediaEffectsKey: string;
  /** Grade intensity 0..1. */
  amount: number;
  /**
   * Opacity to BAKE into the grade (1 when the compositor applies opacity live at composite —
   * mirrors the `bakeOpacity` prop split between scene media and transition sources).
   */
  bakedOpacity: number;
  /** Luma matte ready to sample this frame, or null. Matte presence disables the re-grade skip
   *  (a playing matte video changes pixels without any versioned signal). */
  matte: { source: TexImageSource; invert: boolean; opacity: number } | null;
  /** Legacy per-clip reveal (wipe/iris/dip) — null in scene mode (junctions fold in-compositor). */
  transition: MediaTransition | null;
  transitionKey: string;
  /**
   * TEMPORAL COHERENCE (2026-07-28): how far the frame in `frame` is from the one the LIVE playhead
   * asks for, in TIMELINE seconds. 0 = showing exactly the requested frame. This is the question
   * `frameVersion` (a monotonic counter) structurally cannot answer: "is this texture the one for
   * the frame I am about to present?"
   *
   * Why it exists: a Flarex comp composites several MediaIn loaders, each decoding independently.
   * `gradeMediaInContext` deliberately HOLDS a source's last graded texture when its current frame
   * hasn't landed (the 2026-07-07 black-flicker fix), so a source that has decoded ONCE reads as
   * "ready" forever no matter how stale. The presented composite could therefore mix source A at t
   * with source B at t−0.2 — visible as a comp's sources "filling in" one at a time on a low-end
   * machine. The held pixels are unchanged by this field; it is only what lets the present gate tell
   * "held and correct" from "held and stale".
   *
   * Reported in TIMELINE seconds, not source seconds, so every source is directly comparable to
   * every other regardless of its own speed/in-point — the producer owns `speed`, `preroll` and the
   * mapping clamps, so it is the only layer that can convert without re-deriving them.
   *
   * Null = unknowable or time-invariant, and NEVER gates a present: a still image / generator raster
   * is coherent at every playhead, and a source that has never served a frame is already covered by
   * the existing not-ready path. Null is always the safe answer for a path that cannot know.
   */
  stalenessSeconds: number | null;
  /**
   * The last decodable source time this layer knows about, or null when it knows of none.
   *
   * The SAME value `stalenessSeconds` clamps its request against, surfaced so the clamp's input is
   * observable rather than inferred. Null here is the whole question: a null skips the clamp, and a
   * skipped clamp makes a playhead parked past the material report staleness that grows without bound
   * — lag that does not exist. With this field a large staleness reading is finally decidable:
   *
   *   mediaEnd null                          → the clamp never ran; the reading is an ARTIFACT.
   *   mediaEnd known and ≈ the served time   → the source is correctly pinned at its last frame and
   *                                            the request should have been clamped to it — a bug in
   *                                            the mapping, not in the decoder.
   *   mediaEnd known and well beyond it      → material exists that the decoder is not serving. A
   *                                            genuinely wedged decode, and a different problem.
   *
   * Diagnostic only — nothing reads it to make a decision.
   */
  mediaEndSeconds: number | null;
  /**
   * ATOMIC FULL-RES SWAP (2026-07-28) — the layer's full-res settle frame, OFFERED, not applied.
   *
   * The full-res settle path (user rule 2026-07-05) leases the ORIGINAL bytes ~300ms after the
   * transport parks and native-seeks them, so a paused viewer shows real pixels instead of ~854px
   * proxy pixels. Each source did that independently and swapped itself in the moment its own
   * `seeked` fired — and seek latency on original media is a function of GOP structure, resolution
   * and codec, so a 3-MediaIn comp visibly sharpened one clip at a time, each at a different moment.
   * That is the "fills in one at a time" symptom, and it is NOT a temporal-coherence problem: both
   * the proxy frame and the settled frame represent the same requested time, so `stalenessSeconds`
   * reads ~0 on both sides of the swap and no time-based barrier can see it.
   *
   * The fix is a change of ownership, not of mechanism. The producer publishes its upgrade here and
   * keeps serving `frame` meanwhile; `ScenePreviewCanvas` — the only thing that knows the whole
   * participating set — decides when every source has one and swaps them all in a single composite.
   * Null when there is no upgrade available (still decoding, playing, no separate original).
   */
  fullResFrame: ScenePreviewMediaFrame | null;
  /**
   * True when an upgrade is EXPECTED but not yet ready (paused, a distinct original exists, the
   * debounce/seek has not landed). This is what makes the rendezvous terminate: the compositor waits
   * while any participant is pending and commits when none is, so it never waits on a source that was
   * never going to produce one (a still, a generator, a clip whose proxy IS its original).
   */
  fullResPending: boolean;
  /**
   * AWAITING FRAME (2026-07-28) — this VIDEO source has no decoded frame for the requested time.
   *
   * The gap this closes, found by tracing one ruler click. `stalenessSeconds` is null when a source
   * cannot say where it is, and null never gates a present — justified for a still or a generator,
   * which are correct at every playhead. But a video with no frame yet is the opposite case: it is
   * definitely NOT showing the requested moment. Worse, `gradeMediaInContext` hands back that layer's
   * CACHED PREVIOUS texture (the 2026-07-07 anti-flicker hold) rather than nothing, so the layer also
   * fails to register as not-ready.
   *
   * Neither stale nor not-ready, therefore invisible to both gates: the composite presents with that
   * one source still showing the PREVIOUS playhead's picture, and updates again on its own when the
   * decode lands. That is the residual "one clip changes, then the other" — the trace shows every
   * `shown` row at staleness 0 while one column reads `—`, which is exactly this.
   *
   * True here means "hold for me", bounded by the same `STALE_HOLD_MAX_MS` write-off as any other
   * stale source, so a decoder that never delivers degrades instead of freezing the viewer.
   */
  awaitingFrame: boolean;
  /**
   * DIAGNOSTIC JOIN (2026-07-28) — this source's live decode path and a human-readable asset name.
   *
   * `__rfWcMode` already recorded the decode path, but keyed by SOURCE URL, while the frame profiler
   * names a stalled source by its NODE id (`flarexsrc:<layer>:<nodeId>`). Nothing joined the two, and
   * the node id is not surfaced in the graph UI either — so "which decode path is the source that is
   * stalling on?" was unanswerable from both ends simultaneously. Carrying both here lets the
   * consumer, which already knows the node id, key everything by one identity.
   *
   * Null for non-video sources (a still has no decoder).
   */
  decodeMode: "wc-hw" | "wc-sw" | "element" | null;
  /**
   * Other layers decoding through this source's SAME decoder session right now (0 = sole owner).
   *
   * The duplicate-decode bug this exists to surface — one file read through the host clip AND a
   * pool-asset MediaIn — is invisible in `decodeMode` alone: two rows on one asset look identical
   * whether they share a session or burn two. See `plans/decoder-session-sharing.md`.
   */
  decodeSharedWith: number;
  /** Filename tail of the source URL — what a person can actually recognise in a console dump. */
  sourceLabel: string | null;
}

/** Registered by `WebglMediaLayer`; polled by `ScenePreviewCanvas` at composite time. */
export interface ScenePreviewMediaSource {
  snapshot(): ScenePreviewMediaSnapshot;
}

/** Handed to `WebglMediaLayer` by `VideoPreview` (per layer). Presence of this prop IS the mode
 *  switch: when set, the layer never creates its own GL context. */
export interface SceneMediaSink {
  /** Publish/withdraw this layer's descriptor (called on mount/unmount of the single-ctx mode). */
  register(source: ScenePreviewMediaSource | null): void;
  /** A new raw frame landed — re-arm the scene recomposite (cheap; the analog of onGradedFrame). */
  onFrame(): void;
}
