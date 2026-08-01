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

const DEFAULT_LIVE_BUDGET_MS = 33;

let nextId = 1;
let active: FrameRequest | null = null;

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
export function endFrame(outcome: FrameOutcome): void {
  const request = active;
  active = null;
  if (request === null || !kernelDiagnostics.enabled) return;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const overranBy = request.deadlineMs === null ? 0 : Math.max(0, now - request.deadlineMs);
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
    },
  });
}

/** Test support. Never call from product code — frame ids must stay monotonic within a session. */
export function __resetFrameScheduler(): void {
  nextId = 1;
  active = null;
}
