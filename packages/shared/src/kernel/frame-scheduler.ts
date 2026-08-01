/**
 * Frame Scheduler (ADR-012 3.3, slice S2.1) — frame identity, purpose and lifecycle.
 *
 * ## What this slice does, and what it deliberately does not
 *
 * It gives every composite an **identity**: a monotonic id, the time it is for, the purpose it serves,
 * and a deadline. It changes **nothing** about what is computed, when, or by whom. The rAF loop still
 * drives; this wraps it.
 *
 * That restraint is the point. ADR-012 3.3 has the scheduler owning ordering, cancellation and
 * completion, but a frame cannot be cancelled or completed before it can be *named*, and five separate
 * timeouts in the current runtime exist precisely because nothing could name a frame. Identity first,
 * authority later (S2.2 adds completion, S2.3 adds purpose-scoped resources).
 *
 * ## Deviation from the programme, stated rather than buried
 *
 * The slice catalogue specifies flag `kernel.frameScheduler`, **exclusive**, because "double-scheduling
 * if both the new scheduler and the settle window drive draws". That risk does not exist yet: nothing
 * here drives a draw. A flag guarding a module that only observes would be a flag nobody could ever
 * turn off meaningfully, and it would have to be flipped on before S2.2 could do anything — so the
 * exclusive flag lands with S2.2, where the scheduler first takes authority and where the risk is real.
 *
 * ## Purpose is not decoration
 *
 * ADR-012 §6.1 makes purpose determine deadline, resource scope, degradation policy and cache scope.
 * It is what will keep a thumbnail pass from perturbing live state (I-32) and what lets export declare
 * no deadline at all. Recording it now means every later slice inherits it for free, and it makes the
 * ledger able to answer "was that stall a live frame or a thumbnail?" — which today nothing can.
 */

import { kernelDiagnostics } from "./diagnostics";

/** ADR-012 §6.1. Determines deadline, resource scope, degradation policy and cache scope. */
export type FramePurpose = "live" | "export" | "thumbnail" | "capture" | "analysis";

export interface FrameRequest {
  /** Monotonic across the process. Never reused, so a frame is identifiable in a log after the fact. */
  readonly id: number;
  /** The transport time this frame is FOR. Not the time its sources ended up representing. */
  readonly targetTime: number;
  readonly purpose: FramePurpose;
  /** `performance.now()` when the frame was requested. */
  readonly requestedAt: number;
  /**
   * Wall-clock ms by which this frame wanted to be done, or `null` for "no deadline".
   *
   * `export` carries none by design (ADR-012 §6.8): an export frame has nothing to gain by being
   * rushed and everything to lose by being degraded, which is the opposite of a live frame.
   */
  readonly deadlineMs: number | null;
}

/** How a frame ended. `abandoned` is not a failure — a superseded live frame is the common case. */
export type FrameOutcome = "presented" | "held" | "abandoned" | "failed";

/**
 * What a completed frame tells its consumers (slice S2.2).
 *
 * `settled` is the predicate the whole slice exists to provide: the frame reached the screen AND
 * nothing was outstanding when it did — no stale source, no unready layer. It is the answer to the
 * question five separate timeouts in this runtime are currently guessing at.
 *
 * **`presented` and `settled` are not the same claim**, and conflating them is how the guessing
 * started. A frame presented while a source was stale *did* reach the screen — the barrier is off
 * during playback by design — but it is not the frame anyone waiting for "the picture is ready"
 * meant. A capture that fires on `presented` captures the wrong moment; one that fires on `settled`
 * cannot.
 */
export interface FrameCompletion {
  readonly frame: FrameRequest;
  readonly outcome: FrameOutcome;
  /** Presented AND nothing outstanding. The real "this frame is done" signal. */
  readonly settled: boolean;
  readonly elapsedMs: number;
  /** 0 when the deadline was met, or when the frame declared none. */
  readonly overranByMs: number;
}

const DEFAULT_LIVE_BUDGET_MS = 33;

let nextId = 1;
let active: FrameRequest | null = null;
let begun = 0;
let completed = 0;
let settledCount = 0;

/**
 * Completion listeners. A plain array rather than a Set because it is iterated on every frame and
 * never contains more than a handful — and because iteration order being registration order makes a
 * consumer's behaviour reproducible, which a Set does not guarantee across engines.
 */
const listeners: ((completion: FrameCompletion) => void)[] = [];

/**
 * Subscribe to frame completion. Returns the unsubscribe.
 *
 * This is the replacement for inferring readiness from a timer. A listener MUST NOT throw and MUST NOT
 * begin a frame: it runs inside `endFrame`, after the active frame has been cleared but while the
 * caller is still unwinding its own draw, so scheduling work from here would nest a frame inside the
 * completion of another. Throws are caught and reported rather than propagated, because one bad
 * subscriber must not take down the draw loop that notified it.
 */
export function onFrameCompleted(listener: (completion: FrameCompletion) => void): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}

/**
 * Resolve on the next frame that settles, or `null` if `timeoutMs` elapses first.
 *
 * The timeout is a **reported failure, never a silent fallback** (I-31): a consumer that times out
 * gets `null` and must decide what that means, rather than receiving a frame that was never ready and
 * being unable to tell. That distinction is the difference between this and the settle window it
 * replaces — the window's expiry was indistinguishable from its success.
 */
export function awaitFrameSettled(options?: { purpose?: FramePurpose; timeoutMs?: number }): Promise<FrameCompletion | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onFrameCompleted((completion) => {
      if (!completion.settled) return;
      if (options?.purpose !== undefined && completion.frame.purpose !== options.purpose) return;
      off();
      if (timer !== undefined) clearTimeout(timer);
      resolve(completion);
    });
    const timeoutMs = options?.timeoutMs;
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        off();
        if (kernelDiagnostics.enabled) {
          kernelDiagnostics.record({
            kind: "transition",
            severity: "warn",
            subject: { kind: "runtime" },
            reason: "frame-await-timeout",
            detail: { purpose: options?.purpose ?? "any", timeoutMs },
          });
        }
        resolve(null);
      }, timeoutMs);
    }
  });
}

/**
 * Counters for the termination invariant (I-30): every frame that begins must end.
 *
 * `begun - completed` is 0 outside a frame and 1 inside one. Any other value is a leak, and the
 * conformance suite asserts it directly — the failure it guards against is a `beginFrame` whose
 * `endFrame` was missed on an early return, which would silently mis-attribute every later event.
 */
export function frameSchedulerStats(): { begun: number; completed: number; settled: number; active: boolean } {
  return { begun, completed, settled: settledCount, active: active !== null };
}

/**
 * The frame currently being built, or `null` outside one.
 *
 * Read-only by design. This is the ONE piece of ambient state the kernel tolerates, and it is
 * tolerated only because a frame id is a correlation token rather than an input — nothing decides
 * anything from it. Evaluation time is never read from here; that is rule T4 and it is what keeps
 * evaluation deterministic (ADR-012 I-5).
 */
export function activeFrame(): FrameRequest | null {
  return active;
}

/** Convenience for diagnostics call sites that want the id or nothing. */
export function activeFrameId(): number | undefined {
  return active?.id;
}

/**
 * Open a frame. Returns its identity.
 *
 * Nested calls are not an error and not supported: a thumbnail rendered inside a live frame would be a
 * purpose-scope violation (I-32), so the inner frame simply replaces the outer for the duration and the
 * overlap is REPORTED rather than silently tolerated. S2.3 makes that structurally impossible; until
 * then it is at least visible.
 */
export function beginFrame(purpose: FramePurpose, targetTime: number, budgetMs?: number): FrameRequest {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (active !== null && kernelDiagnostics.enabled) {
    kernelDiagnostics.record({
      kind: "transition",
      severity: "warn",
      subject: { kind: "frame", frameId: active.id },
      reason: "frame-overlap",
      frameId: active.id,
      detail: { outerPurpose: active.purpose, innerPurpose: purpose },
    });
  }
  begun += 1;
  const request: FrameRequest = {
    id: nextId++,
    targetTime,
    purpose,
    requestedAt: now,
    // Export declares no deadline (§6.8). Everything else gets one, defaulting to a frame interval.
    deadlineMs: purpose === "export" ? null : now + (budgetMs ?? DEFAULT_LIVE_BUDGET_MS),
  };
  active = request;
  return request;
}

/**
 * Close the active frame.
 *
 * Records the outcome and whether the deadline was met. Deadline misses are reported, never acted on:
 * ADR-012 §6.12 — budgets are configuration, conformance to them is not, and the excess is attributed
 * rather than corrected. S2.2 turns this into the signal consumers await instead of inferring readiness
 * from a settle window.
 */
export function endFrame(outcome: FrameOutcome, settled = false): void {
  const request = active;
  active = null;
  if (request === null) return;
  completed += 1;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const overranBy = request.deadlineMs === null ? 0 : Math.max(0, now - request.deadlineMs);
  // A frame can only settle by presenting. Enforced here rather than trusted from the caller: "held but
  // settled" is a contradiction that would let a consumer wake on a frame that never reached the
  // screen, which is precisely the class of bug the signal exists to remove.
  //
  // And only a DELIVERING purpose can settle at all (S2.3). `settled` means "the picture is ready", and
  // a thumbnail or capture is one consumer's private picture, at its own time, of its own layer subset
  // — waking a listener on it hands that listener someone else's frame. Enforced rather than left to
  // convention for the same reason as the line above: the call sites that would get it wrong are the
  // ones nobody re-reads. `export` settles because an export frame IS a delivered picture; `analysis`
  // does not, because nothing is delivered.
  const deliveringPurpose = request.purpose === "live" || request.purpose === "export";
  const reallySettled = settled && outcome === "presented" && deliveringPurpose;
  if (reallySettled) settledCount += 1;

  // Notified BEFORE the diagnostics early-return below, and for every frame including healthy ones —
  // consumers are the point of this slice, and a signal that fired only on interesting frames would be
  // a worse timeout than the one it replaces.
  if (listeners.length > 0) {
    const completion: FrameCompletion = {
      frame: request,
      outcome,
      settled: reallySettled,
      elapsedMs: now - request.requestedAt,
      overranByMs: overranBy,
    };
    // Copied because a listener may unsubscribe itself (`awaitFrameSettled` always does), and mutating
    // the array mid-iteration would skip the next subscriber.
    for (const listener of listeners.slice()) {
      try {
        listener(completion);
      } catch (error) {
        if (kernelDiagnostics.enabled) {
          kernelDiagnostics.record({
            kind: "transition",
            severity: "error",
            subject: { kind: "frame", frameId: request.id },
            reason: "frame-listener-threw",
            frameId: request.id,
            detail: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      }
    }
  }

  if (!kernelDiagnostics.enabled) return;
  // Only the interesting frames are recorded individually; a healthy live frame that met its deadline
  // is the overwhelming majority and would drown the ring in noise. The ledger counts those.
  if (outcome === "presented" && overranBy === 0) return;
  kernelDiagnostics.record({
    kind: "transition",
    severity: outcome === "failed" ? "error" : "info",
    subject: { kind: "frame", frameId: request.id },
    reason: overranBy > 0 ? `frame-${outcome}-late` : `frame-${outcome}`,
    frameId: request.id,
    detail: {
      purpose: request.purpose,
      targetTime: Number(request.targetTime.toFixed(4)),
      elapsedMs: Number((now - request.requestedAt).toFixed(2)),
      overranByMs: Number(overranBy.toFixed(2)),
      settled: reallySettled,
    },
  });
}

/** Test support. Never call from product code — frame ids must stay monotonic within a session. */
export function __resetFrameScheduler(): void {
  nextId = 1;
  active = null;
  begun = 0;
  completed = 0;
  settledCount = 0;
  listeners.length = 0;
}

if (typeof globalThis !== "undefined") {
  Object.defineProperty(globalThis, "__rfFrames", {
    configurable: true,
    get: () => ({ ...frameSchedulerStats(), listeners: listeners.length }),
  });
}
