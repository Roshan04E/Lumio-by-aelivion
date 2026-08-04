/**
 * Live frame scope + settle-window ownership (ADR-012 slice S7.1).
 *
 * Extracted verbatim from `ScenePreviewCanvas`, which S7.1 reduces to a surface. Behaviour unchanged
 * and both branches preserved — `kernelFrames` is still default-OFF, so the timer is the live policy
 * and deleting it would be a force-enable, which belongs to S7.2 behind the soaks.
 *
 * ## Why the scope wraps the CALL and not the body
 *
 * `drawFrameImpl` has about a dozen early returns — context lost, both hold gates, the render catch,
 * the recovery paths. A `try/finally` around the CALL is the only placement that cannot miss one, and
 * missing an `endFrame` does not fail loudly: it leaves a frame permanently "active" and silently
 * mis-attributes every later event to it. Frame identity is the thing every other kernel census hangs
 * off, so one leaked scope corrupts all of them at once.
 *
 * The outcome defaults to `abandoned` and settled to `false`, both set BEFORE the call. That is the
 * honest answer for an early return that gave up before deciding anything — and it means a new early
 * return added later is correct by default rather than correct only if someone remembered it.
 *
 * ## The classification is about the state the composite RAN under
 *
 * `classifyComposite` is called before the refs advance, deliberately. Asking afterwards would
 * describe the state the frame produced, and the question the S2.2 counters answer — was this repaint
 * surplus, or was it load-bearing — is about what was true when the work was decided on.
 */

import {
  beginFrame,
  classifyComposite,
  endFrame,
  frameProfiler,
  kernelDiagnostics,
  type CompositorProfilerSnapshot,
  type FrameOutcome,
} from "@orreris/shared";

/** The mutable cells the draw shares with its scope. Held by the caller; this module owns none. */
export interface FrameScopeRefs {
  /** Set at the draw's exit points; `abandoned` until one is reached. */
  readonly outcome: { current: FrameOutcome };
  /** S2.2: assumed false until the present path proves otherwise. */
  readonly settled: { current: boolean };
  readonly prevSettled: { current: boolean };
  readonly rearmedSinceSettled: { current: boolean };
  /** Wall clock the settle window runs until; zeroing it closes the window. */
  readonly activeUntil: { current: number };
}

export interface LiveFrameScopeParams {
  readonly refs: FrameScopeRefs;
  /** Read at scope OPEN and again at close — the transport can move during the draw. */
  readonly targetTimeSeconds: () => number;
  readonly isPlaying: () => boolean;
  readonly draw: () => void;
  readonly profilerSnapshot: () => CompositorProfilerSnapshot | null | undefined;
}

/**
 * Close the scope: classify, report, advance the refs, end the frame.
 *
 * ONE post-frame step for both branches below. Inlining it twice would be two implementations of the
 * window-ownership rule — which is exactly regression G5 — and the profiling branch is the one nobody
 * reads, so that is where the two would drift.
 */
function finishFrame(params: LiveFrameScopeParams): void {
  const settled = params.refs.settled.current;
  const playing = params.isPlaying();
  const kind = classifyComposite({
    playing,
    previousSettled: params.refs.prevSettled.current,
    rearmedSinceSettled: params.refs.rearmedSinceSettled.current,
    settled,
  });
  if ((kind === "surplus" || kind === "load-bearing") && kernelDiagnostics.enabled) {
    kernelDiagnostics.record({
      kind: "transition",
      // `load-bearing` is a WARNING because it is the finding that blocks the flag: a repaint that only
      // the timer caught means some producer arrives without re-arming, and closing the window would
      // lose it. `surplus` is merely waste, and waste is `info`.
      severity: kind === "load-bearing" ? "warn" : "info",
      subject: { kind: "runtime" },
      reason: `settle-window-${kind}`,
      detail: { targetTime: Number(params.targetTimeSeconds().toFixed(4)), outcome: params.refs.outcome.current },
    });
  }
  params.refs.prevSettled.current = settled;
  if (settled) {
    params.refs.rearmedSinceSettled.current = false;
    // THE BEHAVIOURAL HALF OF S2.2, and the only thing the flag gates. Completion replaces the timer:
    // there is provably nothing left to wait for, so the window closes now instead of burning up to
    // 600ms of composites nobody will see. Only while paused — during playback the transport owns the
    // cadence and the window is not consulted at all.
    //
    // Safe only because re-arming is event-driven (`requestDraw` from any async arrival), which is the
    // property the `load-bearing` counter above exists to VERIFY rather than assume.
    if (!playing) params.refs.activeUntil.current = 0;
  }
  endFrame(params.refs.outcome.current, settled);
}

/**
 * Run one live frame inside its kernel scope.
 *
 * The profiling branch is debug-only (`flarexProfile`): it brackets ONE playback frame so the profiler
 * can reset counters, open/close the GPU timer query and time total CPU. Disabled, every call
 * short-circuits and this is byte-for-byte the same as calling the draw directly.
 */
export function runLiveFrameScope(params: LiveFrameScopeParams): void {
  params.refs.outcome.current = "abandoned";
  params.refs.settled.current = false;
  beginFrame("live", params.targetTimeSeconds());

  const profiling = frameProfiler.enabled() && params.isPlaying();
  if (!profiling) {
    try {
      params.draw();
    } finally {
      finishFrame(params);
    }
    return;
  }
  frameProfiler.beginFrame();
  const t0 = performance.now();
  try {
    params.draw();
  } finally {
    frameProfiler.time("frame.cpu", performance.now() - t0);
    frameProfiler.endFrame(params.profilerSnapshot());
    finishFrame(params);
  }
}
