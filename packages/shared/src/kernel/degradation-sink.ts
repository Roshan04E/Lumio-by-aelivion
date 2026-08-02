/**
 * Bridge: Flarex lowering degradations → the kernel diagnostics sink (slice S0.2).
 *
 * The compiler emits `FlarexDegradation` and deliberately knows nothing about the sink — lowering
 * stays free of policy and of kernel dependencies (ADR-012 I-15). This module is the caller-side half:
 * it decides what a degradation *means*, which is a policy question and therefore belongs here.
 *
 * Two decisions live in this file and nowhere else:
 *
 * 1. **Severity.** A substitution is a `warn`: the frame shows another source's pixels, which is the
 *    ADR-012 I-27 violation slice S4.5 deletes. Everything else is `info` — a declared absence is the
 *    *correct* behaviour, and recording it at warning level would train readers to ignore the channel.
 *
 * 2. **Subject identity.** Every degradation is keyed on `node:<compId>/<nodeId>`, so it joins the
 *    source-keyed records a loader produces via `parseFlarexSourceSubject`. This is the join the
 *    2026-08-01 audit had to perform by hand across four incompatible keying schemes.
 *
 * The `substituted` count is the number this slice exists to produce. Until it is known — per node,
 * per project, under which of its three causes — S4.5 is a decision made on principle rather than on
 * evidence, and the audit was explicit that the fallback masks a readiness race the pixel gates
 * currently pass *because of* the substitution.
 */

import type { FlarexDegradation } from "../flarex/degradation";
import { kernelDiagnostics } from "./diagnostics";
import { activeFrameId } from "./frame-scheduler";

/**
 * Record one lowering degradation. Safe to attach unconditionally: when the sink is disabled this
 * costs one property read and allocates nothing, which is what keeps the hot path unperturbed
 * (programme risk R1).
 */
export function recordFlarexDegradation(compId: string, degradation: FlarexDegradation, frameId?: number): void {
  if (!kernelDiagnostics.enabled) return;
  kernelDiagnostics.record({
    kind: "degradation",
    severity: degradation.substituted ? "warn" : "info",
    subject: { kind: "node", compId, nodeId: degradation.nodeId },
    reason: degradation.reason,
    // Falls back to the active frame (S2.1), so correlation is free rather than something every call
    // site has to remember to pass. This is what makes "which frame did that substitution happen in?"
    // answerable — the question the causal chain in tracker playback-preview could only be guessed at.
    frameId: frameId ?? activeFrameId(),
    detail: {
      nodeType: degradation.nodeType ?? "unknown",
      substituted: degradation.substituted,
      // Reported as a delta rather than two absolutes: the only question anyone asks of these is
      // "was this node evaluated at the frame's time?", and a non-zero retime is what separates an
      // honest same-moment degrade from what would have been a different-moment substitution.
      retimeDeltaSeconds: Number((degradation.atTimeSeconds - degradation.frameTimeSeconds).toFixed(6)),
    },
  });
}

export interface FlarexDegradationSummary {
  /** Every degradation recorded, by reason, most frequent first. */
  readonly byReason: { reason: string; count: number }[];
  /** Nodes that showed ANOTHER source's pixels, most frequent first. The I-27 violation census. */
  readonly substitutions: { subject: string; reason: string; count: number }[];
  /** Total substituted frames across all nodes — the single number S4.5 is judged against. */
  readonly substitutedTotal: number;
}

/**
 * Roll up what the sink has seen. Query-path only — allocates, never called per frame.
 *
 * Substitution reasons are matched by their `host-substituted:` prefix rather than by an enumerated
 * list, so a reason added to the vocabulary cannot silently drop out of the census.
 */
export function summarizeFlarexDegradations(): FlarexDegradationSummary {
  return summarize();
}

function summarize(): FlarexDegradationSummary {
  const rows = kernelDiagnostics.summary().filter((row) => row.kind === "degradation");
  const substitutions = rows
    .filter((row) => row.reason.startsWith("host-substituted:"))
    .map((row) => ({ subject: row.subject, reason: row.reason, count: row.count }));
  // Folded BY REASON, which is what the field is called and was not what it did (soak, 2026-08-02).
  // The sink aggregates per (kind, subject, reason), so two nodes degrading for the same cause produced
  // two identical-looking rows — a reader saw `input-missing 680` twice and had no way to tell whether
  // that was one cause counted twice or two nodes counted once. `substitutions` stays per-subject on
  // purpose: there the question is *which node* showed another shot's pixels.
  const byReasonTotals = new Map<string, number>();
  for (const row of rows) byReasonTotals.set(row.reason, (byReasonTotals.get(row.reason) ?? 0) + row.count);
  return {
    byReason: [...byReasonTotals.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    substitutions,
    substitutedTotal: substitutions.reduce((total, row) => total + row.count, 0),
  };
}

// Console handle, beside `__rfKernel`. Discoverability matters more than tidiness here: the whole
// point of the slice is that someone can open a real project and ask "how often does a node show
// another shot's pixels, and which nodes?" without reading any source.
if (typeof globalThis !== "undefined") {
  Object.defineProperty(globalThis, "__rfFlarexDegradation", {
    configurable: true,
    get: () => summarize(),
  });
}
