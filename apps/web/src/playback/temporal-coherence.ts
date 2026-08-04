/**
 * TEMPORAL COHERENCE (2026-07-28) — the rule that a presented frame is a REAL frame.
 *
 * The invariant this module enforces:
 *
 *   > At a fixed timeline position, a presented frame represents ONE requested timeline time across
 *   > every media source participating in it — or it is not presented.
 *
 * Why it was needed. The preview already BATCHES presentation: media layers never draw, they only
 * mark dirty (`publishSceneFrame` → `onFrame` → `requestDraw`), and one rAF loop does a single
 * build → compile → render → present. But batching is not synchronization. The readiness predicate
 * feeding the present gate asked only "does this layer have a texture", and `gradeMediaInContext`
 * deliberately HOLDS a source's last graded texture when its current frame hasn't landed (the
 * 2026-07-07 black-flicker fix) — so a source that decoded ONCE read as ready forever, however
 * stale. A Flarex comp with three MediaIn loaders therefore composited source A at t with source B
 * at t−0.2, visible on a low-end machine as the comp's sources "filling in" one at a time.
 *
 * Presentation batching answers "did everything get drawn together". Temporal synchronization
 * answers "did everything get drawn for the SAME MOMENT". Only the second one is correctness.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────────────────────────
 * Coherence is scoped to ONE viewer's present. A present is atomic per canvas, so the barrier's unit
 * is the graph that canvas evaluated; independent viewers (tool pages, fixtures, proxy capture) each
 * own their own state and can never block one another. Callers pass their own clock in.
 *
 * ── Ownership ────────────────────────────────────────────────────────────────────────────────────
 * `ScenePreviewCanvas` drives this today because presentation ownership lives there. ADR-008 assigns
 * SCHEDULING to the planned evaluation engine; when that engine owns it, this module should move
 * across unchanged rather than be reimplemented. Everything here is pure and framework-free — it
 * knows nothing about GL, React, node types, or the graph's shape, and that is deliberate.
 */

/**
 * Slack allowed before a source counts as showing the wrong frame.
 *
 * This is float noise, NOT a frame budget, because {@link stalenessSeconds} already normalizes away
 * the only legitimate source of disagreement (see its note on subtracting one frame period). A
 * source showing the correct frame reports exactly 0 whatever its frame rate; what remains is µs
 * PTS rounding and a float divide by playback speed.
 *
 * Deriving this from the composition fps would be wrong twice over: the viewer is never given an
 * fps, and source rates differ from the comp's anyway — a comp routinely mixes 24/30/60fps material,
 * so no single frame budget is correct for all of its sources.
 */
import { KERNEL_FLAGS, readKernelFlag } from "./kernel-flags";

export const COHERENCE_TOLERANCE_S = 1e-3;

/**
 * Escape hatch, mirroring `NOT_READY_HOLD_MEDIA_MS`. A source that can never converge — bailed to a
 * `<video>` element, wedged decoder, renamed asset — must not freeze the paused viewer forever. Past
 * this we present the mixed frame anyway, degrading to exactly the pre-2026-07-28 behaviour. Every
 * other hold in this pipeline has such a hatch; a barrier without one is a deadlock with good
 * intentions.
 */
export const STALE_HOLD_MAX_MS = 1500;

/**
 * Frame period assumed for sources that cannot report a rate (the `<video>` element and settle
 * paths; only the WebCodecs provider carries `nominalFps`, estimated from the container sample
 * table). Assuming the SLOWEST rate normal material uses is the safe direction: it can only make the
 * gate more permissive. A genuinely stale source still reads stale by a wide margin — the staggers
 * this exists to catch are 200–300ms, an order of magnitude past any of these periods — whereas
 * assuming a fast rate would hold the present on correctly-served low-frame-rate media.
 */
export const ASSUMED_MIN_FPS = 24;

/**
 * How far a FALLBACK `<video>` element may be from the requested time before its frame is refused.
 *
 * `selectVideoDrawSource` picks settle → WebCodecs → element. When a WC provider exists the element is
 * only a stopgap for the moments WC has nothing, and a pooled element sits wherever its last owner
 * left it — measured tens of seconds away (21.0s worst, on the host layer and a flarex source alike).
 * Drawing that is not "slightly behind", it is a completely different shot, and it was the source of
 * 141 of 144 per-source write-offs: the barrier correctly refused to call it coherent, waited out the
 * full 1.5s budget, and gave up. Refusing the frame converts a wrong picture into a held one, which
 * the not-ready path already handles (it keeps the last graded texture — the 2026-07-07 anti-flicker
 * behaviour) and which the barrier can actually wait on productively.
 *
 * One second, not one frame: this is a "clearly the wrong shot" bound, not a coherence bound. Coherence
 * is decided by {@link stalenessSeconds}, which subtracts a frame period and tolerates only float
 * noise. A tight bound here would reject frames during ordinary seek transients — when the element is
 * the nearest thing to correct available — and turn a brief softness into a brief hole.
 *
 * Applied ONLY when a WC provider exists. With no provider the element IS the primary decode path
 * (`wcDecode` off is still the default), and refusing its frames would blank the layer permanently
 * rather than briefly.
 */
export const ELEMENT_FALLBACK_MAX_LAG_S = 1;


/** One source frame period, exact when the provider knows its rate. */
export function sourceFramePeriodSeconds(nominalFps: number | null | undefined): number {
  return nominalFps != null && Number.isFinite(nominalFps) && nominalFps > 0 ? 1 / nominalFps : 1 / ASSUMED_MIN_FPS;
}

/**
 * How far a source is from the frame the playhead asks for, in TIMELINE seconds. 0 = showing the
 * correct frame. Null = unknowable or time-invariant, which NEVER gates a present (a still image is
 * coherent at every playhead; a source that never served a frame is already covered by the existing
 * not-ready path). Null is always the safe answer for a path that cannot know.
 *
 * ── Why ONE FRAME PERIOD is subtracted, and why that is not a fudge ──────────────────────────────
 * A decoder serves the frame whose presentation interval CONTAINS the request: `getFrame` walks to
 * the last sample with `timestamp <= requested` (`webcodecs-decoder.ts::consumeDecodedUpTo`) and
 * reports `lag = requested − servedTimestamp`. So even a PERFECTLY served source has a raw lag
 * uniformly distributed over [0, framePeriod) — 0…41.7ms on 24fps material — purely because a
 * continuous playhead is being quantized onto a discrete frame grid.
 *
 * Comparing raw lag against a fixed threshold therefore measures the source's FRAME RATE, not its
 * staleness. A half-frame bound would mark correctly-served 24fps media stale about half the time,
 * holding the present on media already showing the right picture — a barrier that fires constantly,
 * falls through to the escape hatch on every scrub, and adds latency while fixing nothing.
 *
 * The question that actually matters is "is this the frame that SHOULD be on screen at t", which is
 * exactly `lag < framePeriod`. Subtracting one period makes 0 mean "correct frame" for every source
 * regardless of rate, so sources of different frame rates become directly comparable — the whole
 * point, since a comp routinely mixes them.
 *
 * ── Why SOURCE space, then divide by speed ───────────────────────────────────────────────────────
 * Rather than inverting the timeline→source mapping. That mapping clamps (at 0, and at −preroll),
 * and in a clamped region it is not invertible: a source parked on a repeated head/tail frame would
 * invert to a wrong timeline time and read permanently stale. In source space a clamped source
 * simply matches the clamped request and reads 0 — correct, because it IS showing the right frame;
 * there just isn't another frame to show.
 *
 * ── Why the request must be clamped at the MEDIA END too (2026-07-28) ────────────────────────────
 * The paragraph above was only half true, and the missing half made this function unusable as an
 * instrument. `WebglMediaLayer::mapSourceTime` clamps the LOW end (0, and −preroll) but has no
 * ceiling, so once the playhead moves past a clip's material the requested source time keeps
 * climbing while the decoder correctly serves the last decodable frame forever. The difference is
 * not staleness — there is no other frame — yet it was reported as tens of seconds of it.
 *
 * That is exactly what the first measurements showed: every source in the comp reading 11–19s stale
 * at once, including sources on unrelated layers. Four simultaneous decoder deaths were never
 * plausible; one missing clamp was. Symmetry with the low end is the rule — a request outside the
 * material in EITHER direction is served by the nearest real frame, and that frame is correct.
 */
export function stalenessSeconds(args: {
  /** Source time the playhead is asking for (already through the clamped timeline→source mapping). */
  requestedSourceTime: number;
  /** Source time the held frame actually represents; null when the path cannot know. */
  servedSourceTime: number | null;
  /** The served source's frame period — see {@link sourceFramePeriodSeconds}. */
  framePeriodSeconds: number;
  /** Playback rate; converts source seconds to timeline seconds so sources are comparable. */
  speed: number;
  /**
   * Last decodable source time, when known (`FrameProvider.decodableEndSeconds`, or the element's
   * duration). Requests past it are clamped: the last frame IS the right answer. Null/undefined
   * simply skips the clamp, so a path that cannot know is never made WORSE than before.
   */
  mediaEndSeconds?: number | null;
}): number | null {
  const { servedSourceTime, framePeriodSeconds, speed, mediaEndSeconds } = args;
  if (servedSourceTime == null || !Number.isFinite(servedSourceTime)) return null;
  if (!Number.isFinite(args.requestedSourceTime)) return null;
  const requestedSourceTime =
    mediaEndSeconds != null && Number.isFinite(mediaEndSeconds) && mediaEndSeconds > 0
      ? Math.min(args.requestedSourceTime, mediaEndSeconds)
      : args.requestedSourceTime;
  // A frozen/zero rate has no timeline↔source correspondence; treat as time-invariant, never divide by 0.
  const rate = Math.abs(speed);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const behind = Math.abs(requestedSourceTime - servedSourceTime);
  return Math.max(0, behind - framePeriodSeconds) / rate;
}

/** A source is coherent when it is showing the frame this present is for. */
export function isStale(staleness: number | null): boolean {
  return staleness != null && staleness > COHERENCE_TOLERANCE_S;
}

/**
 * The gate decision: should this present be withheld until the stale sources catch up?
 *
 * PAUSED ONLY, deliberately. The transport clock is wall-clock servoed to audio and advances
 * regardless of render completion, so under playback the target keeps MOVING while we wait for the
 * slowest source — a strict barrier there would starve rather than synchronize. Making playback
 * coherent means gating the transport, which is a separate decision about the playback model.
 * While playing, `tolerateLag` keeps owning the policy (present the latest advancing frame, never
 * freeze-hold) and this returns false, leaving that path byte-identical to before.
 *
 * ── TWO escape hatches, on two different clocks — both are needed ────────────────────────────────
 * Each alone has a failure mode the other covers, and the stress test reproduces both:
 *
 *   PER-SOURCE (`staleSince`): a source stale for longer than STALE_HOLD_MAX_MS is written off and
 *   stops blocking. Without it, one permanently starved source (bailed decoder, missing asset) blocks
 *   forever; capping only the episode turned the 5-source stress case into 59 presents vs 3941 holds
 *   — a viewer updating once every 1.5s for the rest of the session.
 *
 *   PER-EPISODE (`holdStartedMs`): the contiguous hold is capped regardless. Without it, per-source
 *   budgets bound nothing: sources go stale at different moments, so A's window expires while B's is
 *   still open and C has only just started, and the hold chains through them. The same stress case ran
 *   an episode to 1652ms against a 1500ms per-source cap, and a source going stale just under the cap
 *   repeatedly has no upper bound at all.
 *
 * Same duration, deliberately: "no single source stalls the viewer for longer than this, and neither
 * does any combination of them".
 */

