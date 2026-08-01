/**
 * Presented-frame ledger (ADR-012 slice S0.3) — the coherence instrument.
 *
 * ## Why this exists
 *
 * ADR-012 I-1 says a presented frame represents ONE moment across every participating source, and I-2
 * says presents are monotonic. Neither had an instrument. The runtime measures per-source staleness
 * (`temporal-coherence.ts`) and counts hold episodes, but nothing ever recorded **what was actually put
 * on screen** — so "how often does the viewer present a frame whose sources disagree?" had no answer,
 * and the barrier that would fix it had no bar to clear.
 *
 * This module records every composite the viewer decides on: presented or withheld, with how far apart
 * its sources were. That number is the **baseline slice S4.6 must beat**, and without it the readiness
 * trio would ship on the claim that it improved something unmeasured.
 *
 * ## What "incoherent" means here
 *
 * A present with at least one stale source. Today that happens two ways, and both are by design:
 * during playback the barrier is off entirely (`tolerateLag`), and while paused a hold can expire
 * through one of its two bounded escape hatches. Both are honest degradations under the current
 * architecture — the ledger does not call them bugs, it calls them *countable*.
 *
 * The eventual target is zero in **both** transport states, reached by presenting the latest coherent
 * moment (`effectiveTime`) rather than by holding. `effectiveTime` does not exist yet; the field is
 * present and optional so the ledger does not change shape when S4.4 lands.
 *
 * ## Cost
 *
 * This runs on every composite, so the record is a fixed-size row of primitives written into a
 * preallocated ring — no per-frame array, no set, no string. Identifiers are captured **only** on
 * incoherent frames, which are the rare ones and the ones worth attributing. When the diagnostics sink
 * is disabled the whole path is one boolean read (programme risk R1).
 */

import { kernelDiagnostics } from "./diagnostics";
import { activeFrameId } from "./frame-scheduler";

export type PresentOutcome =
  /** Composited and presented, every participating source at the same moment. */
  | "coherent"
  /** Composited and presented while at least one source was stale — countable, not yet a bug. */
  | "incoherent"
  /** Withheld: a source has NO frame yet. */
  | "held-not-ready"
  /** Withheld: sources have frames, but from different moments. */
  | "held-coherence";

interface PresentRow {
  seq: number;
  atMs: number;
  targetTime: number;
  outcome: PresentOutcome;
  participants: number;
  stale: number;
  notReady: number;
  maxStalenessSeconds: number;
  playing: boolean;
}

export interface PresentSample {
  /** The transport time this composite was for. */
  readonly targetTime: number;
  /** Total media sources participating in the frame. */
  readonly participants: number;
  /** Sources whose delivered frame is from a different moment. */
  readonly staleIds: readonly string[];
  /** Sources with no frame at all. */
  readonly notReadyIds: readonly string[];
  /** Worst per-source staleness this frame, in seconds. The coherence error. */
  readonly maxStalenessSeconds: number;
  readonly playing: boolean;
  /** The source with the worst staleness this frame, when there was one. */
  readonly worstSourceId?: string | undefined;
  /**
   * The moment that worst source was actually showing.
   *
   * Recorded because the staleness NUMBER alone cannot separate the two causes of a large one, and they
   * need opposite responses. A backward seek leaves a source transiently AHEAD of the request and the
   * gap decays as it catches up — real lag, worth holding for. A source whose material has ENDED sits
   * pinned at its last frame while the playhead walks away, so the gap grows linearly with `targetTime`
   * — and that is not lag at all, because past the end the last frame IS the right answer. Without the
   * served time the two are indistinguishable in the ledger, and one of them would have S4.6 chasing a
   * target that cannot be reached.
   */
  readonly worstSourceServedTime?: number | null | undefined;
  /**
   * The last decodable time that source knows of, or null when it knows of none.
   *
   * This is the field that makes a large staleness reading DECIDABLE rather than merely alarming. The
   * staleness math clamps its request against this value; a null skips the clamp entirely, after which
   * a playhead parked past the material accrues staleness without bound — lag that does not exist.
   * Recording the clamp's input beside its output is what separates "the instrument is wrong" from
   * "the decoder is wedged", and those two have nothing in common but the symptom.
   */
  readonly worstSourceMediaEnd?: number | null | undefined;
  /**
   * The moment the frame actually represents, once the runtime can answer that (slice S4.4). Undefined
   * today: the present is *for* `targetTime` and the sources may or may not agree with it, which is
   * precisely the gap this ledger measures.
   */
  readonly effectiveTime?: number | undefined;
}

const RING = 2048;

class PresentLedger {
  private readonly ring: PresentRow[] = Array.from({ length: RING }, () => ({
    seq: -1,
    atMs: 0,
    targetTime: 0,
    outcome: "coherent" as PresentOutcome,
    participants: 0,
    stale: 0,
    notReady: 0,
    maxStalenessSeconds: 0,
    playing: false,
  }));
  private write = 0;
  private seq = 0;

  private counts: Record<PresentOutcome, number> = {
    coherent: 0,
    incoherent: 0,
    "held-not-ready": 0,
    "held-coherence": 0,
  };

  /**
   * Presents that went BACKWARD in time while playing. I-2 forbids reordering; a viewer that cannot
   * keep up must drop, never reorder. Counted separately from incoherence because they have different
   * causes and different fixes — one is a source problem, the other a scheduling problem.
   */
  private nonMonotonic = 0;
  private lastPresentedTime = Number.NEGATIVE_INFINITY;
  private lastPresentedPlaying = false;

  /** Worst coherence error observed on a frame that was actually PRESENTED. */
  private worstPresentedStaleness = 0;

  record(outcome: PresentOutcome, sample: PresentSample): void {
    if (!kernelDiagnostics.enabled) return;

    this.counts[outcome] += 1;
    const presented = outcome === "coherent" || outcome === "incoherent";

    if (presented) {
      if (this.lastPresentedPlaying && sample.playing && sample.targetTime < this.lastPresentedTime) {
        this.nonMonotonic += 1;
      }
      this.lastPresentedTime = sample.targetTime;
      this.lastPresentedPlaying = sample.playing;
      if (sample.maxStalenessSeconds > this.worstPresentedStaleness) {
        this.worstPresentedStaleness = sample.maxStalenessSeconds;
      }
    }

    // Fixed-size row, mutated in place — no allocation on the composite path.
    const row = this.ring[this.write]!;
    row.seq = this.seq++;
    row.atMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    row.targetTime = sample.targetTime;
    row.outcome = outcome;
    row.participants = sample.participants;
    row.stale = sample.staleIds.length;
    row.notReady = sample.notReadyIds.length;
    row.maxStalenessSeconds = sample.maxStalenessSeconds;
    row.playing = sample.playing;
    this.write = (this.write + 1) % RING;

    // Attribution only where it is worth paying for: an incoherent PRESENT is the event this whole
    // slice exists to count, so that one goes to the sink with the offending source ids. Holds are
    // frequent and already summarised by the counters above.
    if (outcome === "incoherent") {
      kernelDiagnostics.record({
        kind: "present",
        severity: "warn",
        subject: { kind: "runtime" },
        reason: sample.playing ? "incoherent-present-playing" : "incoherent-present-paused",
        // Correlates this present with the frame that produced it (S2.1). Undefined until a caller
        // opens a frame, so nothing breaks for callers that have not adopted the scheduler yet.
        frameId: activeFrameId(),
        detail: {
          targetTime: Number(sample.targetTime.toFixed(4)),
          staleCount: sample.staleIds.length,
          maxStalenessSeconds: Number(sample.maxStalenessSeconds.toFixed(4)),
          worstSource: sample.worstSourceId || sample.staleIds[0] || "",
          // The pair that classifies the cause. `served` constant while `targetTime` advances is an
          // ended source (artifact); `served` ahead of the request and closing is a seek transient.
          worstServed: sample.worstSourceServedTime ?? -1,
          // -1 = the source reported no media end, so the clamp never ran on it.
          worstMediaEnd: sample.worstSourceMediaEnd ?? -1,
        },
      });
    }
  }

  summary() {
    const presented = this.counts.coherent + this.counts.incoherent;
    const total = presented + this.counts["held-not-ready"] + this.counts["held-coherence"];
    return {
      ...this.counts,
      presented,
      total,
      /** **The Phase-0 baseline.** Fraction of presented frames whose sources disagreed. */
      incoherenceRate: presented === 0 ? 0 : this.counts.incoherent / presented,
      /** Fraction of composites the viewer decided not to show at all. */
      holdRate: total === 0 ? 0 : (this.counts["held-not-ready"] + this.counts["held-coherence"]) / total,
      nonMonotonicPresents: this.nonMonotonic,
      worstPresentedStalenessSeconds: this.worstPresentedStaleness,
    };
  }

  /** Recent rows, oldest first. Query path only. */
  rows(limit = 200): PresentRow[] {
    const out: PresentRow[] = [];
    for (let i = 0; i < RING; i++) {
      const row = this.ring[(this.write + i) % RING]!;
      if (row.seq >= 0) out.push({ ...row });
    }
    return out.slice(-limit);
  }

  reset(): void {
    for (const row of this.ring) row.seq = -1;
    this.write = 0;
    this.seq = 0;
    this.counts = { coherent: 0, incoherent: 0, "held-not-ready": 0, "held-coherence": 0 };
    this.nonMonotonic = 0;
    this.lastPresentedTime = Number.NEGATIVE_INFINITY;
    this.lastPresentedPlaying = false;
    this.worstPresentedStaleness = 0;
  }
}

export const presentLedger = new PresentLedger();

/**
 * Classify and record in one call, so a caller cannot record a present as coherent while handing over a
 * non-empty stale set. The classification is the ledger's, not the viewer's.
 */
export function notePresent(sample: PresentSample): void {
  if (!kernelDiagnostics.enabled) return;
  presentLedger.record(sample.staleIds.length > 0 ? "incoherent" : "coherent", sample);
}

/** Record a composite the viewer decided not to present. `reason` distinguishes the two hold gates. */
export function noteHeld(reason: "not-ready" | "coherence", sample: PresentSample): void {
  if (!kernelDiagnostics.enabled) return;
  presentLedger.record(reason === "coherence" ? "held-coherence" : "held-not-ready", sample);
}

if (typeof globalThis !== "undefined") {
  Object.defineProperty(globalThis, "__rfPresentLedger", {
    configurable: true,
    get: () => ({
      ...presentLedger.summary(),
      rows: (limit?: number) => presentLedger.rows(limit),
      reset: () => presentLedger.reset(),
    }),
  });
}
