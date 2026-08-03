/**
 * Scene readiness orchestration (ADR-012 slice S7.1).
 *
 * Extracted verbatim from `ScenePreviewCanvas`, which S7.1 reduces to a surface. Behaviour is
 * unchanged and BOTH branches are preserved — see `scene-resource-orchestration.ts` for why S7.1 is
 * extraction rather than deletion while `kernelCoherenceUnified` is still default-OFF.
 *
 * ## Two gates that are routinely confused, and mean opposite things
 *
 * A **not-ready** hold means a source has NO frame at all. A **coherence** hold means it has the WRONG
 * one — pixels from a different moment than the one being presented. They call for opposite fixes (a
 * decode/priority problem versus a synchronisation problem), and the aggregate counters conflate them
 * constantly, which is why the decision below returns which gate fired rather than a bare boolean.
 *
 * ## Why the two clocks are kept apart
 *
 * `blockedSince` and `staleSince` are both "how long has this been blocking", and merging them has
 * been proposed more than once. They must not merge: a source can be READY (has a texture) while
 * STALE (that texture is from the wrong moment), and it can be not-ready without ever having been
 * stale. One map keyed by id with one clock cannot express a source that leaves one state and enters
 * the other, which is the common case at a play flip.
 */

import {
  authoritativeTime,
  deriveTargetTime,
  deriveTimelineTime,
  resolveReadiness,
  servedTime,
} from "@orreris/shared";
import { shouldHoldForCoherence } from "./temporal-coherence";

/**
 * How long a stacked layer's source may stay unready before we give up holding the previous frame and
 * composite anyway — the escape hatch for a permanently-broken source (renamed/missing asset), so the
 * preview never freezes forever waiting on it.
 */
export const NOT_READY_HOLD_MS = 300;
/**
 * Media sources can legitimately need >300ms to (re)prime at play start — proxy-arrival remount,
 * settle→element handoff, cold decoder after load (the play-start black-flicker lineage, tracker
 * playback-preview v20–v24). MEDIA layers hold the last presented picture up to this longer cap —
 * freeze, never black, like every pro NLE — while text/shape keep the short cap (a mid-typing raster
 * must not freeze the viewer for 1.5s).
 */
export const NOT_READY_HOLD_MEDIA_MS = 1500;

/**
 * Advance a per-source blocking clock: start one for anything newly blocked, and clear it for anything
 * that converged.
 *
 * Clearing on convergence is what gives a source a FRESH budget after a later stall rather than
 * inheriting an old one — without it, one early hiccup would permanently disqualify a source from
 * being held for, which reads as an intermittent flash long after the original cause is gone.
 */
export function advanceBlockingClock(
  clock: Map<string, number>,
  blockedIds: readonly string[],
  nowMs: number
): void {
  for (const id of blockedIds) {
    if (!clock.has(id)) clock.set(id, nowMs);
  }
  for (const id of [...clock.keys()]) {
    if (!blockedIds.includes(id)) clock.delete(id);
  }
}

export interface ReadinessDecisionInputs {
  readonly playing: boolean;
  readonly notReadyIds: readonly string[];
  /** Media layers get the longer cap; text/shape keep the short one. */
  readonly isMediaLayerId: (id: string) => boolean;
  readonly blockedSince: ReadonlyMap<string, number>;
  readonly staleIds: readonly string[];
  readonly staleSince: Map<string, number>;
  /** Per-source staleness in seconds; `null` = awaiting, no frame at all. */
  readonly allStaleness: Readonly<Record<string, number | null>>;
  readonly holdStartedMs: number | null;
  readonly nowMs: number;
  readonly targetTimeSeconds: number;
  /** `kernelCoherenceUnified` (S4.6) — default OFF. */
  readonly coherenceUnified: boolean;
  /** The pre-S4.6 barrier's own switch. */
  readonly coherenceHoldEnabled: boolean;
}

export interface ReadinessDecision {
  readonly hold: boolean;
  /**
   * Which gate withheld the frame, or — when presenting — how it got there. `hatch` means the frame is
   * going to the screen WITH disagreement, because a bounded escape fired; that is honest under
   * today's architecture and the count is the baseline S4.6 has to beat.
   */
  readonly reason: "coherence" | "not-ready" | "coherent" | "hatch";
}

/**
 * Hold or present, and why.
 *
 * The unified branch (S4.6) resolves the latest moment EVERY participant can show and withholds only
 * when even that cannot be served — the `degraded` verdict. Paused and playing take the same path,
 * which is the point: the old barrier returned false on its first line while playing, so playback had
 * no coherence policy at all and `tolerateLag` stood in for one.
 */
export function decideSceneReadiness(inputs: ReadinessDecisionInputs): ReadinessDecision {
  const heldIds = inputs.playing ? inputs.notReadyIds : inputs.notReadyIds.filter(inputs.isMediaLayerId);
  const notReadyHold = heldIds.some(
    (id) =>
      inputs.nowMs - (inputs.blockedSince.get(id) ?? inputs.nowMs) <
      (inputs.isMediaLayerId(id) ? NOT_READY_HOLD_MEDIA_MS : NOT_READY_HOLD_MS)
  );

  const coherenceHold = inputs.coherenceUnified
    ? resolveReadiness(
        deriveTargetTime(deriveTimelineTime(authoritativeTime(inputs.targetTimeSeconds))),
        Object.entries(inputs.allStaleness).map(([id, staleness]) => ({
          id,
          // `Infinity` is the caller's existing encoding for "awaiting, no frame at all" — the
          // barrier's `null`, which is a declared degradation rather than an input to the minimum.
          // A finite staleness means the source HAS pixels, from `t - staleness` seconds ago.
          servedTime:
            staleness === null
              ? undefined
              : Number.isFinite(staleness)
                ? servedTime(inputs.targetTimeSeconds - staleness)
                : null,
        }))
      ).outcome === "degraded"
    : shouldHoldForCoherence({
        playing: inputs.playing,
        staleIds: [...inputs.staleIds],
        staleSince: inputs.staleSince,
        holdStartedMs: inputs.holdStartedMs,
        nowMs: inputs.nowMs,
        enabled: inputs.coherenceHoldEnabled,
      });

  if (notReadyHold || coherenceHold) {
    // Which gate actually withheld this frame. A not-ready hold means a source has NO frame; a
    // coherence hold means it has the WRONG one.
    return { hold: true, reason: inputs.staleIds.length > 0 ? "coherence" : "not-ready" };
  }
  return { hold: false, reason: inputs.staleIds.length === 0 ? "coherent" : "hatch" };
}
