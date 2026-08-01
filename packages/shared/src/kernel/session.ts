/**
 * Runtime Session (ADR-012 3.1, slice S3.1) — the kernel's lifetime and its container.
 *
 * ## What a session is
 *
 * One runtime, with one state registry and one lifetime. A live editor viewer is a session. A headless
 * export is a session. The conformance harness makes one per scenario. They do not share state, and
 * that independence is the property I-37 is built on: a runtime you can only have one of cannot be
 * driven twice in one process, so it cannot be tested against itself.
 *
 * ## Why this exists before anything moves into it
 *
 * S3.1 builds the container and moves NOTHING. That is deliberate. Every later Phase 3 slice relocates
 * one subsystem's state, and each of those is independently revertible only if the destination already
 * exists and is already proven. Building the container in the same change as the first migration would
 * make "the registry is wrong" and "the media manager moved badly" the same bug.
 *
 * ## The default session, and why it is not an apology
 *
 * `defaultSession` is the process-wide session the existing call sites use without knowing it. It looks
 * like the module-level singleton this design is meant to replace, and the distinction is real: the
 * singleton is now a *value of a type you can have more than one of*, so a caller that needs isolation
 * takes its own, and the harness always does. Ambient DEFAULTS are convenience; ambient TYPES are the
 * thing that made the old runtime untestable.
 *
 * The frame scheduler is deliberately NOT yet session-scoped — it still holds module state, which its
 * own header admits. Moving it is a behavioural change to the live draw loop and belongs with the
 * slices that take scheduling authority, not with the slice that builds the container.
 *
 * ## I-36
 *
 * Nothing in this directory may import a UI framework, touch the DOM, or call a rendering API. That is
 * asserted MECHANICALLY by the conformance harness, which reads these files and greps them — a prose
 * rule about imports is worth nothing the first time someone needs `document` in a hurry.
 */

import { StateRegistry } from "./state-registry";

export interface RuntimeSessionOptions {
  /** Stable, human-readable. Appears in diagnostics, so make it identify the CALLER, not the instance. */
  readonly id: string;
}

export class RuntimeSession {
  readonly id: string;
  readonly state = new StateRegistry();
  readonly createdAt: number;
  private disposed = false;

  constructor(options: RuntimeSessionOptions) {
    this.id = options.id;
    this.createdAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Release everything this session owns.
   *
   * Idempotent, because the callers that will eventually drive this — a React unmount, a context loss
   * recovery, an export finishing — can all fire twice, and a lifecycle that only survives being ended
   * once is the lifecycle that produced the double-release class of decoder bug.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state.dispose();
  }
}

export function createRuntimeSession(options: RuntimeSessionOptions): RuntimeSession {
  return new RuntimeSession(options);
}

/**
 * The process-wide session. Convenience for callers that genuinely have only one runtime — which is
 * every current caller, because nothing has moved into a session yet.
 */
export const defaultSession = createRuntimeSession({ id: "default" });
